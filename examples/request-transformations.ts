/**
 * Live check of credential brokering via E2B egress transform rules, using
 * the session methods this provider adds: `addRequestTransformations`,
 * `setRequestTransformations`, `setNetworkPolicy`.
 *
 * Run: E2B_API_KEY=... npx tsx --env-file-if-exists=.env examples/request-transformations.ts
 */
import { randomUUID } from 'node:crypto';
import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';

const HOST = 'httpbin.org';
const SECRET = 'brokered-secret-' + randomUUID();

const session = await createE2BSandbox({ template: 'base' }).createSession();
let failed = false;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
};
const headersSeen = async () => {
  const { stdout, exitCode } = await session.run({
    command: `curl -sS --max-time 20 https://${HOST}/headers`,
  });
  if (exitCode !== 0) return null;
  return JSON.parse(stdout).headers as Record<string, string>;
};

try {
  console.log(session.description);

  // 1. baseline: no injected header
  const before = await headersSeen();
  check('reachable before rules', before != null);
  check('no Authorization before rules', before?.Authorization == null);

  // 2. addRequestTransformations → egress proxy injects secret
  await session.addRequestTransformations!([
    {
      match: { host: HOST },
      transform: { headers: { Authorization: `Bearer ${SECRET}` } },
    },
  ]);
  const after = await headersSeen();
  check(
    'Authorization injected at egress',
    after?.Authorization === `Bearer ${SECRET}`,
    after?.Authorization
  );

  // 3. secret never present inside the sandbox
  const { stdout: envDump } = await session.run({
    command: 'env; cat /proc/self/environ 2>/dev/null | tr "\\0" "\\n"',
  });
  check('secret absent from sandbox env', !envDump.includes(SECRET));

  // 4. add a second header additively; both must survive
  await session.addRequestTransformations!([
    { match: { host: HOST }, transform: { headers: { 'X-Brokered': 'yes' } } },
  ]);
  const added = await headersSeen();
  check('add keeps previous rule', added?.Authorization === `Bearer ${SECRET}`);
  check('add applies new rule', added?.['X-Brokered'] === 'yes');

  // 5. setNetworkPolicy must NOT wipe transformation rules (caveat B)
  await session.setNetworkPolicy!({ mode: 'custom', allowedHosts: [HOST] });
  const afterPolicy = await headersSeen();
  check(
    'rules survive setNetworkPolicy',
    afterPolicy?.Authorization === `Bearer ${SECRET}`,
    afterPolicy?.Authorization
  );
  const { exitCode: blocked } = await session.run({
    command: 'curl -sS --max-time 10 https://example.com -o /dev/null',
  });
  check('policy blocks other hosts', blocked !== 0, `curl exit ${blocked}`);

  // 6. setRequestTransformations replaces: X-Brokered gone, Authorization stays
  await session.setRequestTransformations!([
    {
      match: { host: HOST },
      transform: { headers: { Authorization: `Bearer ${SECRET}` } },
    },
  ]);
  const replaced = await headersSeen();
  check('set drops rules not re-sent', replaced?.['X-Brokered'] == null);
  check(
    'set keeps re-sent rule',
    replaced?.Authorization === `Bearer ${SECRET}`
  );

  // 7. unsupported matcher rejected
  await session.addRequestTransformations!([
    {
      match: { host: HOST, method: ['POST'] },
      transform: { headers: { A: 'b' } },
    },
  ]).then(
    () => check('rejects method matcher', false),
    (e) => check('rejects method matcher', true, e.name)
  );

  // 8. clear
  await session.setRequestTransformations!([]);
  const cleared = await headersSeen();
  check('empty set clears rules', cleared?.Authorization == null);
} finally {
  await session.destroy?.();
  console.log(failed ? '\nLIVE TEST FAILED' : '\nALL LIVE CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
}
