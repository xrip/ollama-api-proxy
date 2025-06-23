#!/usr/bin/env node

// ===================================================
// Multi-Provider Ollama Proxy Server
// Proxies requests from ollama api to to Gemni/OpenAI
// ===================================================

import http from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';
import { ColorConsole } from './console.js';
import dotenv from 'dotenv';

dotenv.config();

global.console = new ColorConsole({
    stdout: process.stdout,
    stderr: process.stderr,
    timestamp: process.env.NODE_ENV !== 'production',
});

// Configuration
const PROXY_PORT = 11434;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Validate API Keys
if (!OPENAI_API_KEY && !GEMINI_API_KEY) {
    console.error('❌ Error: Neither OPENAI_API_KEY nor GEMINI_API_KEY is set. Please set at least one API key.');
    process.exit(1);
}

if (!OPENAI_API_KEY) {
    console.warn('⚠️ Warning: OPENAI_API_KEY is not set. OpenAI models will not be available.');
}

if (!GEMINI_API_KEY) {
    console.warn('⚠️ Warning: GEMINI_API_KEY is not set. Gemini models will not be available.');
}

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TOP_P = 0.9;
const DEFAULT_TOP_K = 40;

// Model configurations
const MODELS = {
    // OpenAI Chat Models
    'gpt-4o': { provider: 'openai', type: 'chat', model: 'gpt-4o' },
    'gpt-4o-mini': { provider: 'openai', type: 'chat', model: 'gpt-4o-mini' },
    'gpt-4.1-mini': { provider: 'openai', type: 'chat', model: 'gpt-4.1-mini' },
    'gpt-4.1-nano': { provider: 'openai', type: 'chat', model: 'gpt-4.1-nano' },

    // Gemini Models
    'gemini-2.0-flash': { provider: 'gemini', type: 'chat', model: 'gemini-2.0-flash' },
    'gemini-2.5-flash': { provider: 'gemini', type: 'chat', model: 'gemini-2.5-flash' },
};

// Helper functions
function validateModel(modelName) {
    const config = MODELS[modelName];
    if (!config) {
        throw new Error(`Model ${modelName} not supported`);
    }
    return config;
}

function createOllamaResponse(modelName, content, isGenerate = false) {
    const baseResponse = {
        model: modelName,
        created_at: new Date().toISOString(),
        done: true,
    };

    if (isGenerate) {
        return { ...baseResponse, response: content };
    }

    return {
        ...baseResponse,
        message: {
            role: 'assistant',
            content,
        },
    };
}


const corsHeaders = response => Object.entries({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}).forEach(([key, value]) => {
    response.setHeader(key, value);
});

function sendJsonResponse(response, data, status = 200) {
    corsHeaders(response);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
}

const requestBody = (request) => new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => body += chunk.toString());
    request.on('end', () => {
        try {
            const jsonData = body ? JSON.parse(body) : {};
            resolve(jsonData);
        } catch (error) {
            reject(new Error(`Invalid JSON: ${error.message}`));
        }
    });
    request.on('error', reject);
});

// OpenAI API functions
async function callOpenAI(endpoint, data) {
    const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

function convertToOpenAI(ollamaRequest, modelName) {
    const options = ollamaRequest.options || {};

    return {
        model: modelName,
        messages: ollamaRequest.messages || [],
        temperature: options.temperature || DEFAULT_TEMPERATURE,
        max_tokens: options.num_predict || DEFAULT_MAX_TOKENS,
        top_p: options.top_p || DEFAULT_TOP_P,
    };
}

function convertFromOpenAI(response, modelName, isGenerate = false) {
    const content = response.choices?.[0]?.message?.content || 'No response generated';
    if (!response.choices?.[0]?.message?.content) {
        console.error(response);
    }
    return createOllamaResponse(modelName, content, isGenerate);
}

// Gemini API functions
async function callGemini(endpoint, data) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${endpoint}?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

function convertToGemini(ollamaRequest) {
    const messages = ollamaRequest.messages || [];
    const options = ollamaRequest.options || {};
    const contents = [];

    for (const message of messages) {
        const part = { text: message.content };

        if (message.role === 'user') {
            contents.push({ parts: [part], role: 'user' });
        } else if (message.role === 'assistant') {
            contents.push({ parts: [part], role: 'model' });
        } else if (message.role === 'system') {
            // Prepend system message to first user message or create new user message
            if (contents.length === 0 || contents[0].role !== 'user') {
                contents.unshift({ parts: [part], role: 'user' });
            } else {
                contents[0].parts[0].text = `${message.content}\n\n${contents[0].parts[0].text}`;
            }
        }
    }

    return {
        contents,
        generationConfig: {
            temperature: options.temperature || DEFAULT_TEMPERATURE,
            maxOutputTokens: options.num_predict || DEFAULT_MAX_TOKENS,
            topP: options.top_p || DEFAULT_TOP_P,
            topK: options.top_k || DEFAULT_TOP_K,
        },
    };
}

function convertFromGemini(response, modelName, isGenerate = false) {
    const content = response.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated';
    if (!response.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error(response.candidates?.[0]);
    }

    return createOllamaResponse(modelName, content, isGenerate);
}

// Route handlers
async function handleChat(request, response) {
    const ollamaRequest = await requestBody(request);
    const modelConfig = validateModel(ollamaRequest.model);

    switch (modelConfig.provider) {
        case 'openai' : {
            console.debug('openai');

            const openAiResonse = await callOpenAI(
                'chat/completions',
                convertToOpenAI(ollamaRequest, modelConfig.model),
            );

            return sendJsonResponse(response, convertFromOpenAI(openAiResonse, ollamaRequest.model));
        }
        case 'gemini' : {
            console.debug('gemini');
            const geminiResponse = await callGemini(
                `${modelConfig.model}:generateContent`,
                convertToGemini(ollamaRequest),
            );

            return sendJsonResponse(response, convertFromGemini(geminiResponse, ollamaRequest.model));
        }
    }
}

async function handleGenerate(req, res) {
    const ollamaRequest = await requestBody(req);
    const modelConfig = validateModel(ollamaRequest.model);

    // Convert generate request to chat format
    const chatRequest = {
        messages: [{ role: 'user', content: ollamaRequest.prompt }],
        options: ollamaRequest.options,
        model: ollamaRequest.model,
    };

    if (modelConfig.provider === 'openai') {
        const openaiRequest = convertToOpenAI(chatRequest, modelConfig.model);
        const openaiResponse = await callOpenAI('chat/completions', openaiRequest);
        const result = convertFromOpenAI(openaiResponse, ollamaRequest.model, true);
        sendJsonResponse(res, result);
        return;
    }

    if (modelConfig.provider === 'gemini') {
        const geminiRequest = convertToGemini(chatRequest);
        const geminiResponse = await callGemini(`${modelConfig.model}:generateContent`, geminiRequest);
        const result = convertFromGemini(geminiResponse, ollamaRequest.model, true);
        sendJsonResponse(res, result);
        return;
    }
}

function handleTags(req, res) {
    const models = Object.entries(MODELS).map(([name, config]) => ({
        name,
        model: name,
        modified_at: new Date().toISOString(),
        size: config.provider === 'openai' ? 6400000000 : 4274519832,
        digest: `sha256:${config.provider}-${name.replace(/[^a-zA-Z0-9]/g, '')}-digest`,
        details: {
            parent_model: '',
            format: 'gguf',
            family: config.provider === 'openai' ? 'gpt' : 'llama',
            families: [config.provider === 'openai' ? 'gpt' : 'llama'],
            parameter_size: '1024.0B',
            quantization_level: 'Q8_0',
        },
    }));

    sendJsonResponse(res, { models });
}

// Route mapping
const routes = {
    'GET /': (request, response) => response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Ollama Multi-Provider Proxy is running'),
    'GET /api/version': (request, response) => sendJsonResponse(response, { version: '1.0.0' }),
    'GET /api/tags': handleTags,
    'POST /api/chat': handleChat,
    'POST /api/generate': handleGenerate,
};

// Create HTTP server
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const routeKey = `${req.method} ${url.pathname}`;

    console.info(`${routeKey}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        corsHeaders(res);
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        const handler = routes[routeKey];
        if (!handler) {
            sendJsonResponse(res, { error: 'Not found' }, 404);
            return;
        }

        await handler(req, res);
    } catch (error) {
        console.error('Error:', error.message);
        sendJsonResponse(res, { error: error.message }, 500);
    }
});

// Start server
server.listen(PROXY_PORT, () => {
    console.log(`✅ Server running on port ${PROXY_PORT}`);
    console.log(`🔑 OpenAI API Key: ${OPENAI_API_KEY ? '✅ SET' : '❌ NOT SET'}`);
    console.log(`🔑 Gemini API Key: ${GEMINI_API_KEY ? '✅ SET' : '❌ NOT SET'}`);
    console.log(`📋 Supported models: \n- ${Object.keys(MODELS).join(',\n- ')}\n`);
    console.log(`🌐 Health check: http://localhost:${PROXY_PORT}/\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down proxy server...');
    server.close(() => {
        console.log('✅ Server stopped gracefully');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down...');
    server.close(() => {
        process.exit(0);
    });
});