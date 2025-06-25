// console.js - Simplified ColorConsole for Node.js
import { WriteStream } from 'node:tty';

export class ColorConsole {
    constructor({ stdout = process.stdout, stderr = process.stderr, timestamp = false } = {}) {
        this.stdout = stdout;
        this.stderr = stderr;
        this.timestamp = timestamp;
        this.timers = new Map();
    }

    static colors = {
        reset: '\x1b[0m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        gray: '\x1b[90m',
    };

    colorize(text, color) {
        const hasColor = this.stdout instanceof WriteStream && this.stdout.isTTY;
        return hasColor ? `${ColorConsole.colors[color]}${text}${ColorConsole.colors.reset}` : text;
    }

    format(args, prefix = '', color = null) {
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
        const colored = color ? this.colorize(prefix + message, color) : prefix + message;
        const timestamp = this.timestamp ? `${this.colorize(`[${new Date().toLocaleString()}]`, 'gray')} ` : '';
        return timestamp + colored;
    }

    log(...args) {
        this.stdout.write(this.format(args) + '\n');
    }

    info(...args) {
        this.stdout.write(this.format(args, 'ℹ️ ', 'blue') + '\n');
    }

    warn(...args) {
        this.stderr.write(this.format(args, '⚠️ ', 'yellow') + '\n');
    }

    error(...args) {
        this.stderr.write(this.format(args, '❌ ', 'red') + '\n');
    }

    debug(...args) {
        if (process.env.NODE_ENV !== 'production') {
            this.stdout.write(this.format(args, '🐛 ', 'magenta') + '\n');
        }
    }

    success(...args) {
        this.stdout.write(this.format(args, '✅ ', 'green') + '\n');
    }

    assert(condition, ...args) {
        if (!condition) {
            this.error('Assertion failed:', ...args);
        }
    }

    time(label) {
        this.timers.set(label, Date.now());
    }

    timeEnd(label) {
        if (this.timers.has(label)) {
            const elapsed = Date.now() - this.timers.get(label);
            this.timers.delete(label);
            this.log(`${label}: ${elapsed}ms`);
        }
    }

    clear() {
        if (this.stdout instanceof WriteStream && this.stdout.isTTY) {
            this.stdout.write('\x1b[2J\x1b[H');
        }
    }

    // Aliases
    dir = this.log;
    trace = this.debug;
}