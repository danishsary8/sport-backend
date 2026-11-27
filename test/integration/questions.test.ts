import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { JERSEY, staffToken } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const ask = (body: object, app = ctx.app) => request(app).post(`/v1/catalog/products/${JERSEY}/questions`).send(body);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from product_questions');
  await q('delete from notification_outbox');
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'qa-admin', 'admin');
});

describe('product questions', () => {
  it('queues a guest question for staff and keeps it private until answered and published', async () => {
    const res = await ask({ authorName: 'Dara', question: 'Does the M fit a 70 kg player?' }).expect(201);
    expect(res.body).toEqual({ status: 'pending' });
    expect((await q("select template, recipient from notification_outbox")).rows).toEqual([{ template: 'question_received', recipient: 'ops' }]);
    const empty = await request(ctx.app).get(`/v1/catalog/products/${JERSEY}/questions`).expect(200);
    expect(empty.body.questions).toEqual([]);
    expect(empty.headers['cache-control']).toBe('public, no-cache');

    const list = await request(ctx.app).get('/v1/admin/questions?status=pending').set(bearer(admin)).expect(200);
    expect(list.body.total).toBe(1);
    const id = list.body.questions[0].id;
    expect(list.body.questions[0]).toMatchObject({ productSlug: JERSEY, authorName: 'Dara' });

    const noAnswer = await request(ctx.app).patch(`/v1/admin/questions/${id}`).set(bearer(admin)).send({ status: 'published' }).expect(400);
    expect(noAnswer.body.error.code).toBe('answer_required');
    await request(ctx.app).patch(`/v1/admin/questions/${id}`).set(bearer(admin)).send({ answer: 'Yes, M fits 65–75 kg.', status: 'published' }).expect(200);

    const published = await request(ctx.app).get(`/v1/catalog/products/${JERSEY}/questions`).expect(200);
    expect(published.body.questions).toHaveLength(1);
    expect(published.body.questions[0]).toMatchObject({ authorName: 'Dara', question: 'Does the M fit a 70 kg player?', answer: 'Yes, M fits 65–75 kg.' });
    expect(published.body.questions[0].answeredAt).toBeTruthy();
    expect(Object.keys(published.body.questions[0]).sort()).toEqual(['answer', 'answeredAt', 'authorName', 'createdAt', 'id', 'question']);

    await request(ctx.app).patch(`/v1/admin/questions/${id}`).set(bearer(admin)).send({ status: 'hidden' }).expect(200);
    expect((await request(ctx.app).get(`/v1/catalog/products/${JERSEY}/questions`).expect(200)).body.questions).toEqual([]);
  });

  it('stores HTML as plain text', async () => {
    await ask({ authorName: '<b>x</b>', question: '<script>alert(1)</script> real question?' }).expect(201);
    expect((await q('select question, author_name from product_questions')).rows[0]).toEqual({ question: '<script>alert(1)</script> real question?', author_name: '<b>x</b>' });
  });

  it('validates the question, the name and the product', async () => {
    await ask({ authorName: 'Dara', question: 'Size' }).expect(400);
    await ask({ authorName: 'Dara', question: 'x'.repeat(501) }).expect(400);
    await ask({ authorName: '', question: 'Is this real leather?' }).expect(400);
    await request(ctx.app).post('/v1/catalog/products/no-such-product/questions').send({ authorName: 'Dara', question: 'Is this real?' }).expect(404);
  });

  it('remembers the member who asked, without showing it', async () => {
    const member = ctx.fake.token({ uid: 'qa-member', phone: '+85512008888' });
    await request(ctx.app).post(`/v1/catalog/products/${JERSEY}/questions`).set(bearer(member)).send({ authorName: 'Sok', question: 'Is there a kids size?' }).expect(201);
    expect((await q('select user_id from product_questions')).rows[0].user_id).toBeTruthy();
  });

  it('keeps moderation for staff only', async () => {
    const customer = await staffToken(ctx.app, database, ctx.fake, 'qa-customer', 'customer');
    await request(ctx.app).get('/v1/admin/questions').set(bearer(customer)).expect(403);
  });

  it('limits a visitor to 5 questions a minute', async () => {
    const limited = memberApp(database, undefined, { routeLimits: true });
    for (let i = 0; i < 5; i++) await ask({ authorName: 'Spam', question: `Question number ${i}?` }, limited.app).expect(201);
    await ask({ authorName: 'Spam', question: 'Question number 6?' }, limited.app).expect(429);
  });
});
