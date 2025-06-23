# Ollama to OpenAI/Gemni Proxy

A Multi-Provider Ollama Proxy Server that allows using JetBrains AI Assistant with third-party commercial LLMs like
OpenAI and Google Gemini, taking advantage of their free tier usage.

## Overview

This proxy server translates requests from the Ollama API format to either OpenAI or Google Gemini API formats, allowing
you to use these commercial LLMs with tools that support the Ollama API, such as JetBrains AI Assistant.

The server runs on port 11434 (the same port as Ollama) and requires API keys for OpenAI and/or Gemini, configured via
environment variables.

## Features

- Seamless integration with JetBrains AI Assistant
- Support for multiple LLM providers:
    - OpenAI models
    - Google Gemini models
- Compatible with Ollama API endpoints:
    - `/api/chat` - for chat completions
    - `/api/generate` - for text generation
    - `/api/tags` - for listing available models
    - `/api/version` - for version information

## Supported Models

### OpenAI Models

- gpt-4o
- gpt-4o-mini
- gpt-4.1-mini
- gpt-4.1-nano

### Google Gemini Models

- gemini-2.0-flash
- gemini-2.5-flash

## Installation

### Prerequisites

- Node.js >= 18.0.0 or Bun >= 1.2.0
- API key for OpenAI and/or Google Gemini

### Using npm

```bash
# Clone the repository
git clone https://github.com/xrip/ollama-api-proxy.git
cd ollama-proxy

# Install dependencies
npm install

# Create .env file with your API keys
echo "OPENAI_API_KEY=your_openai_api_key" > .env
echo "GEMINI_API_KEY=your_gemini_api_key" >> .env

# Start the server
npm start
```

### Using Docker

```bash
# Clone the repository
git clone https://github.com/xrip/ollama-api-proxy.git
cd ollama-proxy

# Create .env file with your API keys
echo "OPENAI_API_KEY=your_openai_api_key" > .env
echo "GEMINI_API_KEY=your_gemini_api_key" >> .env

# Build and run the Docker container
docker build -t ollama-proxy .
docker run -p 11434:11434 --env-file .env ollama-proxy
```

### Using npx (Node.js)

```bash
# Create a directory for your configuration
mkdir ollama-proxy-config
cd ollama-proxy-config

# Create .env file with your API keys
echo "OPENAI_API_KEY=your_openai_api_key" > .env
echo "GEMINI_API_KEY=your_gemini_api_key" >> .env

# Run the proxy server using npx
npx ollama-api-proxy

# Alternatively, you can specify a specific version
# npx ollama-api-proxy@1.0.0
```

### Using bunx (Bun)

```bash
# Create a directory for your configuration
mkdir ollama-proxy-config
cd ollama-proxy-config

# Create .env file with your API keys
echo "OPENAI_API_KEY=your_openai_api_key" > .env
echo "GEMINI_API_KEY=your_gemini_api_key" >> .env

# Run the proxy server using bunx
bunx ollama-api-proxy

# Alternatively, you can specify a specific version
# bunx ollama-api-proxy@1.0.0
```

## Configuration

The proxy server is configured using environment variables:

- `OPENAI_API_KEY`: Your OpenAI API key (required for OpenAI models)
- `GEMINI_API_KEY`: Your Google Gemini API key (required for Gemini models)
- `NODE_ENV`: Set to `production` for production use or `development` for development

You can set these variables in a `.env` file in the project root.

## Usage with JetBrains AI Assistant

1. Start the Ollama Proxy server
2. Configure JetBrains AI Assistant to use Ollama
3. Set the Ollama server URL to `http://localhost:11434`
4. Select one of the available models (e.g., `gpt-4o`, `gemini-2.5-flash`)

## Development

```bash
# Run in development mode with hot reloading (requires Bun)
npm run dev
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
