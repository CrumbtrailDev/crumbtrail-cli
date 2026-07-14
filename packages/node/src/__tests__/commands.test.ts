import { describe, it, expect } from 'vitest';
import { parseCommand } from '../commands';

describe('parseCommand', () => {
  it('defaults to serve when no args are given (back-compat)', () => {
    expect(parseCommand([])).toEqual({ command: 'serve', rest: [] });
  });

  it('treats bare flags as serve args (back-compat)', () => {
    expect(parseCommand(['--port', '3000', '--mcp'])).toEqual({
      command: 'serve',
      rest: ['--port', '3000', '--mcp'],
    });
  });

  it('routes the init subcommand and strips the command word', () => {
    expect(parseCommand(['init', '--yes'])).toEqual({
      command: 'init',
      rest: ['--yes'],
    });
  });

  it('routes the doctor subcommand and strips the command word', () => {
    expect(parseCommand(['doctor', '--port', '9898'])).toEqual({
      command: 'doctor',
      rest: ['--port', '9898'],
    });
  });

  it('routes an explicit serve subcommand', () => {
    expect(parseCommand(['serve', '--port', '4000'])).toEqual({
      command: 'serve',
      rest: ['--port', '4000'],
    });
  });

  it('routes help for --help, -h, and the help word', () => {
    expect(parseCommand(['help']).command).toBe('help');
    expect(parseCommand(['--help']).command).toBe('help');
    expect(parseCommand(['-h']).command).toBe('help');
  });

  it('routes the scan subcommand', () => {
    expect(parseCommand(['scan', './src'])).toEqual({ command: 'scan', rest: ['./src'] });
  });

  it('routes the inspect subcommand and strips the command word', () => {
    expect(parseCommand(['inspect', 'ses_1', '--json'])).toEqual({
      command: 'inspect',
      rest: ['ses_1', '--json'],
    });
  });

  it('still defaults bare flags to serve', () => {
    expect(parseCommand(['--port', '3000'])).toEqual({ command: 'serve', rest: ['--port', '3000'] });
  });
});
