export async function readOllamaEventStream(body, onContent, startedAt = performance.now()) {
  let timeToFirstTokenMs = null;
  let accumulatedContent = '';
  let finalEvent = null;
  let pending = '';

  const processLine = (line) => {
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('Ollama returned an invalid streaming response.');
    }

    const thinking = event?.message?.thinking;
    const content = event?.message?.content;
    if (timeToFirstTokenMs === null && ((typeof thinking === 'string' && thinking.length > 0) || (typeof content === 'string' && content.length > 0))) {
      timeToFirstTokenMs = Math.round(performance.now() - startedAt);
    }

    // Ollama sends hidden reasoning and the user-facing answer in separate fields.
    // Only content is accumulated or forwarded to the Study Helper UI.
    if (typeof content === 'string' && content.length > 0) {
      accumulatedContent += content;
      onContent?.(accumulatedContent, content);
    }

    if (event?.done) finalEvent = event;
  };

  const decoder = new TextDecoder();
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  pending += decoder.decode();
  if (pending.trim()) processLine(pending);

  return { content: accumulatedContent, finalEvent, timeToFirstTokenMs };
}
