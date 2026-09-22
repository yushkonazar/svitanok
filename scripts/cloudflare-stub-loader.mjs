// Лише для Node-генераторів контрактів: вони читають декларації реєстру, але
// не запускають Worker-код. Miniflare/workerd лишаються середовищем runtime-тестів.
const workerStub = [
  'export class DurableObject {}',
  'export class WorkflowEntrypoint {}',
  'export class WorkerEntrypoint {}',
].join('\n');

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(workerStub)}`,
    };
  }
  return nextResolve(specifier, context);
}
