import { request } from 'node:http';

/**
 * @typedef {Object} OllamaMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} content
 */

/**
 * @typedef {Object} OllamaResponse
 * @property {string} model
 * @property {OllamaMessage} message
 * @property {boolean} done
 * @property {string} [done_reason]
 */

/**
 * Minimal Ollama API client.
 * Uses native Node.js http module — zero dependencies.
 */
export class OllamaClient {
  /**
   * @param {string} host - e.g. "http://localhost:11434"
   */
  constructor(host) {
    this.host = host.replace(/\/+$/, '');
  }

  /**
   * Send a chat completion request (non-streaming).
   * @param {string} model
   * @param {OllamaMessage[]} messages
   * @param {object} [options]
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @param {number} [options.topP]
   * @param {number} [options.topK]
   * @param {number} [options.repeatPenalty]
   * @param {number} [options.numCtx]
   * @returns {Promise<OllamaResponse>}
   */
  async chat(model, messages, options = {}) {
    const body = {
      model,
      messages,
      stream: false,
      options: {},
    };

    if (options.temperature !== undefined) body.options.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.options.num_predict = options.maxTokens;
    if (options.topP !== undefined) body.options.top_p = options.topP;
    if (options.topK !== undefined) body.options.top_k = options.topK;
    if (options.repeatPenalty !== undefined) body.options.repeat_penalty = options.repeatPenalty;
    if (options.numCtx !== undefined) body.options.num_ctx = options.numCtx;

    const response = await this._post('/api/chat', body);

    // Handle Qwen3.5 models that return content in a "thinking" field
    // instead of the standard "content" field in the message.
    // Qwen3.5 response format:
    //   { "message": { "content": "", "thinking": "Thinking Process:\n\n1. ..." } }
    // Standard format:
    //   { "message": { "content": "Hello!" } }
    if (response?.message) {
      const msg = response.message;
      // If content is empty/whitespace and thinking exists with content, use thinking
      if ((!msg.content || !msg.content.trim()) && msg.thinking && msg.thinking.trim()) {
        msg.content = msg.thinking;
      }
      // Also handle the case where content exists but thinking has additional context
      // (don't overwrite content if it already has meaningful text)
    }

    return response;
  }

  /**
   * List available models.
   * @returns {Promise<{models: Array<{name: string}>}>}
   */
  listModels() {
    return this._get('/api/tags');
  }

  /**
   * Check if a model is available.
   * @param {string} modelName
   * @returns {Promise<boolean>}
   */
  async isModelAvailable(modelName) {
    try {
      const { models } = await this.listModels();
      return models.some(m => m.name === modelName);
    } catch {
      return false;
    }
  }

  /**
   * Pull a model from Ollama.
   * @param {string} modelName
   * @returns {Promise<void>}
   */
  pullModel(modelName) {
    return this._post('/api/pull', { name: modelName, stream: false });
  }

  /**
   * Internal: make a POST request.
   * @private
   */
  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.host);
      const payload = JSON.stringify(body);

      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 300_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(JSON.parse(data));
              } else {
                reject(new Error(`Ollama API error (${res.statusCode}): ${data}`));
              }
            } catch (err) {
              reject(new Error(`Failed to parse Ollama response: ${err.message}\nRaw: ${data}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(new Error(`Ollama request failed: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Ollama request timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Internal: make a GET request.
   * @private
   */
  _get(path) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.host);

      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          timeout: 30_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(JSON.parse(data));
              } else {
                reject(new Error(`Ollama API error (${res.statusCode}): ${data}`));
              }
            } catch (err) {
              reject(new Error(`Failed to parse Ollama response: ${err.message}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(new Error(`Ollama request failed: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Ollama request timed out'));
      });

      req.end();
    });
  }
}
