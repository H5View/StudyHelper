import SwiftUI

struct PopupView: View {
    @ObservedObject var viewModel: PopupViewModel

    var body: some View {
        HStack(spacing: 10) {
            if viewModel.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white.opacity(0.9))
            }

            Text(viewModel.message)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(6)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(width: 260, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.black.opacity(0.88))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(.white.opacity(0.08), lineWidth: 1)
        )
    }
}
