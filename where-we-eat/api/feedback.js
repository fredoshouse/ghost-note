import { list, put } from '@vercel/blob';

// Votes carry their whole payload in the pathname (votes/<rating>/<uuid>), so a
// tally is a list() with no reads and no read-modify-write. Every write lands on
// its own key, which is what keeps concurrent votes from clobbering each other.
const RATINGS = ['1', '2', '3', '4', '5'];
const LIMITS = { name: 80, city: 60, who: 40, why: 400 };
const MAX_PICKS = 60;

const clean = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

async function readAll() {
  const [votes, spots] = await Promise.all([
    list({ prefix: 'votes/', limit: 1000 }),
    list({ prefix: 'spots/', limit: 200 }),
  ]);

  const tally = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const blob of votes.blobs) {
    const rating = blob.pathname.split('/')[1];
    if (rating in tally) tally[rating] += 1;
  }

  const newest = [...spots.blobs]
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, MAX_PICKS);

  const picks = (
    await Promise.all(
      newest.map(async (blob) => {
        try {
          const res = await fetch(blob.url, { cache: 'no-store' });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  return { ok: true, tally, picks };
}

async function write(body) {
  // Honeypot: a real person never fills a field they cannot see.
  if (clean(body.trap, 10)) return { status: 200, payload: { ok: true, skipped: true } };

  if (body.type === 'vote') {
    const rating = String(body.rating);
    if (!RATINGS.includes(rating)) {
      return { status: 400, payload: { ok: false, reason: 'bad-rating' } };
    }
    await put(`votes/${rating}/${crypto.randomUUID()}`, '1', {
      access: 'public',
      contentType: 'text/plain',
    });
    return { status: 200, payload: await readAll() };
  }

  if (body.type === 'spot') {
    const pick = {
      name: clean(body.name, LIMITS.name),
      city: clean(body.city, LIMITS.city),
      who: clean(body.who, LIMITS.who),
      why: clean(body.why, LIMITS.why),
      at: new Date().toISOString(),
    };
    if (!pick.name || !pick.city) {
      return { status: 400, payload: { ok: false, reason: 'name-and-city-required' } };
    }
    await put(`spots/${crypto.randomUUID()}.json`, JSON.stringify(pick), {
      access: 'public',
      contentType: 'application/json',
    });
    return { status: 200, payload: await readAll() };
  }

  return { status: 400, payload: { ok: false, reason: 'unknown-type' } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Until a Blob store is connected to the project there is no token, and the
  // page reads this as "not switched on yet" rather than showing a broken poll.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ ok: false, reason: 'store-not-connected' });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await readAll());
    }

    if (req.method === 'POST') {
      const raw = req.body;
      const body = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
      const { status, payload } = await write(body);
      return res.status(status).json(payload);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, reason: 'method-not-allowed' });
  } catch (err) {
    console.error('feedback handler failed', err);
    return res.status(500).json({ ok: false, reason: 'server-error' });
  }
}
