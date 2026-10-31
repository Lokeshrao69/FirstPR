// Minimal mock of the Gemini generateContent API, for offline testing of the agent loop.
import http from 'node:http';

const PORT = process.env.MOCK_PORT || 4010;
export const seen = [];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    seen.push(j);
    const contents = j.contents || [];
    const toolTurns = contents.filter((c) => c.parts?.some((p) => p.functionResponse)).length;
    const hasImage = contents.some((c) => c.parts?.some((p) => p.inlineData));
    const lastUserText = [...contents].reverse().find((c) => c.parts?.some((p) => p.text))?.parts.find((p) => p.text).text || '';
    let parts;
    if (!req.headers['x-goog-api-key']) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'no key' } })); }
    if (toolTurns === 0) parts = [{ functionCall: { name: 'search_graph', args: { query: hasImage ? 'forward block_size' : 'attention' } } }];
    else if (toolTurns === 1) parts = [{ functionCall: { name: 'explain_node', args: { node: 'CausalSelfAttention' } } }, { functionCall: { name: 'impact_of_change', args: { node: 'model_causalselfattention' } } }];
    else parts = [{ text: `## Answer\nAttention lives in [[model_causalselfattention]] (\`model.py:L29\`), used by [[model_block]]. image=${hasImage} sys=${!!j.systemInstruction} q="${lastUserText.slice(0, 40)}"` }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }));
  });
}).listen(PORT, () => console.log('mock gemini on', PORT));

// OpenAI-compatible mock (Ollama / vLLM style) on MOCK_PORT+1
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const toolMsgs = j.messages.filter((m) => m.role === 'tool').length;
    const hasImage = j.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
    const message = toolMsgs === 0
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_path', arguments: JSON.stringify({ from: 'train.py', to: 'CausalSelfAttention' }) } }] }
      : { role: 'assistant', content: `Path found via [[model]] to [[model_causalselfattention]] image=${hasImage} model=${j.model}` };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
}).listen(Number(PORT) + 1);
