import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kitDir } from '../src/config.js';

const prompt = readFileSync(join(kitDir(), 'PROMPT.md'), 'utf8');

// The inputs of the breakrocks CLI MCP tools PROMPT.md calls (breakrocks CLI 0.14+): the post is
// addressed by `id`, never by `postId`, or the tool refuses the call with INVALID_INPUT.
describe('PROMPT.md calls of the breakrocks MCP tools', () => {
  it('edits a post with the id the tool expects', () => {
    expect(prompt).toContain('breakrocks_posts_edit({ id: postId, text })');
    expect(prompt).not.toMatch(/breakrocks_\w+\(\{([^}]*,)?\s*postId\s*[,}]/);
  });

  it('gives every post tool its post as `id`', () => {
    for (const tool of ['breakrocks_repost', 'breakrocks_reply', 'breakrocks_posts_edit']) {
      const calls = [...prompt.matchAll(new RegExp(`${tool}\\(\\{([^}]*)\\}\\)`, 'g'))];
      expect(calls.length, tool).toBeGreaterThan(0);
      for (const c of calls) expect(c[1], tool).toMatch(/\bid\b/);
    }
  });
});
