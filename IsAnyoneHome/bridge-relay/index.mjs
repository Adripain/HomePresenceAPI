/*
 * Outbound-only local relay. It never opens an inbound port and therefore works
 * behind a residential NAT. It receives only queued, idempotent actions over TLS.
 */
const apiBaseURL = (process.env.API_BASE_URL ?? '').replace(/\/$/, '');
const enrollmentCode = process.env.ENROLLMENT_CODE;
let relaySecret = process.env.RELAY_SECRET;
const relayName = process.env.RELAY_NAME ?? 'Home relay';

if (!apiBaseURL.startsWith('https://')) throw new Error('API_BASE_URL must use HTTPS');
if (!relaySecret && !enrollmentCode) throw new Error('Set RELAY_SECRET or one-time ENROLLMENT_CODE');

async function api(path, options = {}) {
  const response = await fetch(`${apiBaseURL}${path}`, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response.json();
}

async function claim() {
  const result = await api('/v1/relays/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: enrollmentCode, name: relayName })
  });
  relaySecret = result.secret;
  // This is intentionally the only time the secret is printed. Store it in a
  // root-readable environment file, then remove ENROLLMENT_CODE.
  console.log(`Relay claimed. Save this value as RELAY_SECRET, then restart: ${relaySecret}`);
  process.exit(0);
}

function relayHeaders() {
  return { authorization: `Relay ${relaySecret}` };
}

async function bridgeConfig() {
  const result = await api('/v1/relay/config', { headers: relayHeaders() });
  return result.bridge;
}

async function turnOffAllLights(config) {
  const response = await fetch(`http://${config.host}/api/${encodeURIComponent(config.username)}/groups/0/action`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: false }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Local bridge rejected the command (${response.status})`);
  const result = await response.json();
  if (Array.isArray(result) && result.some((item) => item.error)) throw new Error('Local bridge returned an error');
}

async function complete(command, status, error) {
  await api(`/v1/relay/commands/${command.id}/complete`, {
    method: 'POST',
    headers: { ...relayHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ status, ...(error ? { error: String(error).slice(0, 300) } : {}) })
  });
}

async function tick() {
  await api('/v1/relay/heartbeat', { method: 'POST', headers: relayHeaders() });
  const command = await api('/v1/relay/commands/next', { headers: relayHeaders() });
  if (!command) return;
  try {
    const config = await bridgeConfig();
    if (command.action === 'turn_off_all_lights') await turnOffAllLights(config);
    else throw new Error('Unsupported action');
    await complete(command, 'completed');
  } catch (error) {
    console.error(`Command ${command.id} failed: ${error.message}`);
    await complete(command, 'failed', error.message);
  }
}

if (!relaySecret) await claim();
setInterval(() => void tick().catch((error) => console.error(`Relay error: ${error.message}`)), 4_000);
await tick();
