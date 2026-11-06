import { waitFor } from './helpers.js';

export async function waitForSend(receipt, readStatus, options = {}) {
  if (typeof receipt?.msg_id !== 'string' || !['pending', 'sent'].includes(receipt.state)) throw Error('send did not queue a message');
  return waitFor(async () => {
    const entry = (await readStatus()).sends.find(row => row.msg_id === receipt.msg_id);
    if (entry?.state === 'failed') throw Error('queued send failed before relay delivery');
    return entry?.state === 'sent' && entry;
  }, { ...options, what: 'queued message to reach sent in status.sends' });
}
