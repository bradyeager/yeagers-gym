import fs from 'node:fs/promises';

// Reviewed exact mappings only; no customer inference or email content in output.
export async function loadCalendarEmailIdentities(file, clients) {
  let document;
  try { document = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (document.version !== 1 || !Array.isArray(document.mappings)) throw new Error('Invalid calendar identity allowlist');
  const counts = new Map();
  for (const client of clients) counts.set(client.vagaro_name, (counts.get(client.vagaro_name) || 0) + 1);
  const identities = {};
  for (const entry of document.mappings) {
    if (!/^[a-f0-9]{64}$/.test(entry.email_sha256 || '') || counts.get(entry.vagaro_name) !== 1 || !entry.evidence) {
      throw new Error('Calendar identity allowlist requires an exact authorized roster identity and evidence');
    }
    (identities[entry.email_sha256] ||= []).push(entry.vagaro_name);
  }
  return identities;
}
