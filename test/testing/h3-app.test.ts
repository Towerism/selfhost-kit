import { defineEventHandler } from 'h3';
import { describe, expect, it } from 'vitest';
import { h3TestApp } from '../../src/testing/h3-app.js';

describe('h3TestApp, as Nitro wires its app', () => {
  it('runs the request hook before the middleware, and still answers when a hook throws', async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const app = h3TestApp({
      plugins: [
        (nitro) => {
          nitro.hooks.hook('request', () => {
            order.push('hook');
            throw new Error('bad hook');
          });
          nitro.hooks.hook('error', (error: unknown) => {
            errors.push(error);
          });
        },
      ],
      middleware: [defineEventHandler(() => void order.push('middleware'))],
      routes: { '/': defineEventHandler(() => 'ok') },
    });
    const res = await app.fetch('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(order).toEqual(['hook', 'middleware']);
    expect(errors).toEqual([expect.objectContaining({ message: 'bad hook' })]);
  });

  it('answers an unknown path with Nitro’s JSON 404', async () => {
    const res = await h3TestApp().fetch('/nowhere');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toMatchObject({ error: true, statusCode: 404 });
  });

  it('passes clientAddress through as the request’s peer', async () => {
    const app = h3TestApp({
      routes: { '/': defineEventHandler((event) => ({ peer: event.context.clientAddress })) },
    });
    expect(await (await app.fetch('/', { clientAddress: '192.0.2.1' })).json()).toEqual({
      peer: '192.0.2.1',
    });
  });
});
