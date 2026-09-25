import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type ToolContract = {
  tools: Record<string, { execution: { route: string; kind?: string; kindFrom?: string } }>;
};

describe('generated tool contract', () => {
  it('is valid, reviewed documentation with an explicit contract version', async () => {
    const artifact = JSON.parse(await readFile('docs/generated/tool-contract.json', 'utf8'));
    expect(artifact.contract_version).toBe(1);
    expect(artifact.tools).toHaveProperty('reminders.create');
  });

  it('makes every mutating tool explicit about policy routing', () => {
    // npm test first regenerates the artifact check from the real core registry.
    // This test protects the most important human-facing policy invariant too.
    const contract = JSON.parse(
      readFileSync('docs/generated/tool-contract.json', 'utf8'),
    ) as ToolContract;
    for (const [name, definition] of Object.entries(contract.tools)) {
      if ('kind' in definition.execution || 'kindFrom' in definition.execution) {
        expect(definition.execution.route, name).toBe('policy');
      }
    }
  });
});
