import Foundation

struct HealthStatus: Decodable {
    let bridge: String
    let ollama: String
    let model: String
}

private struct StudyAnswerResponse: Decodable {
    let answer: String
}

private struct StudyAnswerRequest: Encodable {
    let text: String
    let outputMode: String
}

private struct BridgeErrorResponse: Decodable {
    let error: String
}

enum BridgeClientError: Error {
    case pcUnavailable
    case answerTimedOut
    case modelUnavailable
    case requestFailed
}

struct BridgeClient {
    private let configuration: AppConfiguration
    private let session: URLSession

    init(configuration: AppConfiguration) {
        self.configuration = configuration

        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = configuration.studyAnswerRequestTimeout
        sessionConfiguration.timeoutIntervalForResource = configuration.studyAnswerRequestTimeout
        self.session = URLSession(configuration: sessionConfiguration)
    }

    func fetchHealth() async throws -> HealthStatus {
        let url = configuration.bridgeBaseURL.appending(path: "health")
        var request = URLRequest(url: url)
        request.timeoutInterval = configuration.healthRequestTimeout

        debugLog("health request started timeout=\(Int(configuration.healthRequestTimeout))s")

        let (data, response) = try await perform(request, kind: .health)
        let httpResponse = try requireHTTPResponse(response)
        debugLog("health response status=\(httpResponse.statusCode)")

        guard (200...299).contains(httpResponse.statusCode) else {
            throw BridgeClientError.pcUnavailable
        }

        return try JSONDecoder().decode(HealthStatus.self, from: data)
    }

    func fetchStudyAnswer(for rawText: String, outputMode: AnswerDisplayMode) async throws -> String {
        let text = normalizeSelection(rawText)
        guard !text.isEmpty else {
            throw BridgeClientError.requestFailed
        }

        guard text.count <= configuration.maxSelectionLength else {
            throw BridgeClientError.requestFailed
        }

        let url = configuration.bridgeBaseURL.appending(path: "study-answer")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = configuration.studyAnswerRequestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(configuration.studyToken, forHTTPHeaderField: "X-Study-Assistant-Token")
        request.httpBody = try JSONEncoder().encode(StudyAnswerRequest(text: text, outputMode: outputMode.rawValue))

        debugLog("study-answer request started chars=\(text.count) timeout=\(Int(configuration.studyAnswerRequestTimeout))s mode=\(outputMode.rawValue)")

        let (data, response) = try await perform(request, kind: .studyAnswer)
        let httpResponse = try requireHTTPResponse(response)
        debugLog("study-answer response status=\(httpResponse.statusCode)")

        guard (200...299).contains(httpResponse.statusCode) else {
            throw mapBridgeError(statusCode: httpResponse.statusCode, data: data)
        }

        let decoded = try JSONDecoder().decode(StudyAnswerResponse.self, from: data)
        return decoded.answer.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func perform(_ request: URLRequest, kind: RequestKind) async throws -> (Data, URLResponse) {
        let start = ContinuousClock.now

        do {
            let result = try await session.data(for: request)
            let elapsed = start.duration(to: .now)
            debugLog("\(kind.rawValue) elapsedMs=\(elapsedMilliseconds(elapsed))")
            return result
        } catch {
            let elapsed = start.duration(to: .now)
            debugLog("\(kind.rawValue) elapsedMs=\(elapsedMilliseconds(elapsed))")
            debugLog("\(kind.rawValue) networkingError=\(String(describing: error))")
            throw mapTransportError(error, kind: kind)
        }
    }

    private func requireHTTPResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BridgeClientError.requestFailed
        }
        return httpResponse
    }

    private func mapTransportError(_ error: Error, kind: RequestKind) -> BridgeClientError {
        guard let urlError = error as? URLError else {
            return .requestFailed
        }

        switch urlError.code {
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet:
            return .pcUnavailable
        case .timedOut:
            return kind == .studyAnswer ? .answerTimedOut : .pcUnavailable
        default:
            return .requestFailed
        }
    }

    private func mapBridgeError(statusCode: Int, data: Data) -> BridgeClientError {
        let decoded = try? JSONDecoder().decode(BridgeErrorResponse.self, from: data)
        let errorText = decoded?.error.lowercased() ?? ""

        if statusCode == 504 || errorText.contains("timed out") {
            return .answerTimedOut
        }

        if statusCode == 502 || statusCode == 503 {
            if errorText.contains("ollama") || errorText.contains("model") {
                return .modelUnavailable
            }
            return .requestFailed
        }

        return .requestFailed
    }

    private func normalizeSelection(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func debugLog(_ message: String) {
#if DEBUG
        print("[StudyHelper DEBUG] \(message)")
#endif
    }

    private func elapsedMilliseconds(_ duration: Duration) -> Int {
        let components = duration.components
        let seconds = components.seconds * 1_000
        let attoseconds = components.attoseconds / 1_000_000_000_000_000
        return Int(seconds + attoseconds)
    }
}

private enum RequestKind: String {
    case health = "health"
    case studyAnswer = "study-answer"
}
