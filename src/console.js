// console.js - Simple ColorConsole implementation for Node.js
import { WriteStream } from 'tty';

export class ColorConsole {
    constructor(options = {}) {
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;
        this.timestamp = options.timestamp || false;
    }

    // ANSI color codes
    static colors = {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        dim: '\x1b[2m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        gray: '\x1b[90m',
    };

    // Check if output supports colors
    supportsColor(stream) {
        return stream instanceof WriteStream && stream.isTTY;
    }

    // Format message with color
    colorize(message, color) {
        if (!this.supportsColor(this.stdout)) {
            return message;
        }
        return `${ColorConsole.colors[color]}${message}${ColorConsole.colors.reset}`;
    }

    // Add timestamp if enabled
    addTimestamp(message) {
        if (!this.timestamp) {
            return message;
        }
        const now = new Date().toISOString();
        const timestamp = this.colorize(`[${now}]`, 'gray');
        return `${timestamp} ${message}`;
    }

    // Format arguments like console methods
    formatArgs(args) {
        return args.map(arg => {
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(' ');
    }

    // Console methods
    log(...args) {
        const message = this.formatArgs(args);
        const output = this.addTimestamp(message);
        this.stdout.write(output + '\n');
    }

    info(...args) {
        const message = this.formatArgs(args);
        const colored = this.colorize('ℹ️ ' + message, 'blue');
        const output = this.addTimestamp(colored);
        this.stdout.write(output + '\n');
    }

    warn(...args) {
        const message = this.formatArgs(args);
        const colored = this.colorize('⚠️ ' + message, 'yellow');
        const output = this.addTimestamp(colored);
        this.stderr.write(output + '\n');
    }

    error(...args) {
        const message = this.formatArgs(args);
        const colored = this.colorize('❌ ' + message, 'red');
        const output = this.addTimestamp(colored);
        this.stderr.write(output + '\n');
    }

    debug(...args) {
        if (process.env.NODE_ENV === 'production') {
            return; // Skip debug in production
        }
        const message = this.formatArgs(args);
        const colored = this.colorize('🐛 ' + message, 'magenta');
        const output = this.addTimestamp(colored);
        this.stdout.write(output + '\n');
    }

    success(...args) {
        const message = this.formatArgs(args);
        const colored = this.colorize('✅ ' + message, 'green');
        const output = this.addTimestamp(colored);
        this.stdout.write(output + '\n');
    }

    // Alias methods to match standard console
    dir(...args) {
        this.log(...args);
    }

    trace(...args) {
        this.debug(...args);
    }

    assert(condition, ...args) {
        if (!condition) {
            this.error('Assertion failed:', ...args);
        }
    }

    time(label) {
        this._timers = this._timers || new Map();
        this._timers.set(label, Date.now());
    }

    timeEnd(label) {
        this._timers = this._timers || new Map();
        if (this._timers.has(label)) {
            const elapsed = Date.now() - this._timers.get(label);
            this._timers.delete(label);
            this.log(`${label}: ${elapsed}ms`);
        }
    }

    clear() {
        if (this.supportsColor(this.stdout)) {
            this.stdout.write('\x1b[2J\x1b[H');
        }
    }
}