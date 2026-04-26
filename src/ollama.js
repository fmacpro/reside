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
   * @returns {Promise<OllamaResponse>}
   */
  chat(model, messages, options = {}) {
    const body = {
      model,
      messages,
      stream: false,
      options: {},
    };

    if (options.temperature !== undefined) body.options.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.options.num_predict = options.maxTokens;

    return this._post('/api/chat', body);
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
          timeout: 120_000,
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
