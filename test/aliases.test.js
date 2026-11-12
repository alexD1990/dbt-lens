'use strict';
// Which model a name like `prep1` in `prep1.order_id` stands for.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importAliases, boxIdOf } = require('../src/aliases');

test('import CTEs written by dbt Lens and by hand', () => {
  const sql = `
with

prep1 as (
    select * from {{ ref('prep1') }}
),

Stores AS (SELECT * FROM {{ ref("source3") }}),

orders as (select * from {{ source('raw', 'orders') }} o),

pkg as (select * from {{ ref('other_pkg', 'shared_model') }}),

joined as (
    select * from prep1 left join stores on prep1.store_id = stores.store_id
)

select prep1.order_id from joined`;
  const a = importAliases(sql);
  assert.deepEqual(a.get('prep1'), { kind: 'ref', name: 'prep1' });
  assert.deepEqual(a.get('stores'), { kind: 'ref', name: 'source3' });
  assert.deepEqual(a.get('orders'), { kind: 'source', source: 'raw', table: 'orders' });
  assert.deepEqual(a.get('pkg'), { kind: 'ref', name: 'shared_model' });
  assert.equal(a.has('joined'), false, 'a CTE that does more than select * is not resolved');
});

test('aliases right after ref() and source()', () => {
  const sql = `select p.id, o.status
from {{ ref('prep1') }} as p
inner join {{ source('raw', 'orders') }} o on o.id = p.id
left join {{ ref('prep2') }}
where 1 = 1`;
  const a = importAliases(sql);
  assert.deepEqual(a.get('p'), { kind: 'ref', name: 'prep1' });
  assert.deepEqual(a.get('o'), { kind: 'source', source: 'raw', table: 'orders' });
  assert.equal(a.has('where'), false);
  assert.equal(a.has('on'), false);
});

test('comments are ignored and versions do not confuse refs', () => {
  const sql = `-- old as (select * from {{ ref('old') }})
/* x as (select * from {{ ref('x') }}) */
cur as (select * from {{ ref('orders', v=2) }})`;
  const a = importAliases(sql);
  assert.equal(a.has('old'), false);
  assert.equal(a.has('x'), false);
  assert.deepEqual(a.get('cur'), { kind: 'ref', name: 'orders' });
});

test('box ids', () => {
  assert.equal(boxIdOf({ kind: 'ref', name: 'prep1' }), 'prep1');
  assert.equal(boxIdOf({ kind: 'source', source: 'raw', table: 'orders' }), 'source:raw.orders');
});

test('nothing to find', () => {
  assert.equal(importAliases('').size, 0);
  assert.equal(importAliases(null).size, 0);
  assert.equal(importAliases('select 1 as id').size, 0);
});
