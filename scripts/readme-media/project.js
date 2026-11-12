'use strict';
// The small dbt project shown in the README media. Same shape as the tpch_dbt demo
// (seeds → staging → intermediate → marts), with names that read well in a picture.

const fs = require('fs');
const path = require('path');

const cte = (name, expr) => `${name} as (\n    select * from {{ ${expr} }}\n)`;
const imports = (...parts) => `with\n\n${parts.join(',\n\n')}\n`;

const FILES = {
  'dbt_project.yml': `name: 'shop_analytics'
version: '1.0.0'
profile: 'shop_analytics'

model-paths: ["models"]
seed-paths: ["seeds"]

models:
  shop_analytics:
    staging:
      +materialized: view
    intermediate:
      +materialized: view
    marts:
      +materialized: table
`,
  'seeds/raw_customers.csv': 'customer_id,customer_name,region,signup_date\n1,Ada,north,2026-01-04\n',
  'seeds/raw_orders.csv': 'order_id,customer_id,store_id,order_date,amount,status\n1,1,1,2026-09-01,120.0,shipped\n',
  'seeds/raw_stores.csv': 'store_id,store_name,region,city\n1,Harbour,north,Bergen\n',
  'seeds/raw_store_targets.csv': 'store_id,target_month,target_amount\n1,2026-09,5000\n',
  'models/staging/_sources.yml': `version: 2

sources:
  - name: stripe
    tables:
      - name: payments
`,
  'models/staging/stg_customers.sql': `${imports(cte('raw_customers', "ref('raw_customers')"))}
select
    customer_id,
    customer_name,
    region,
    signup_date
from raw_customers
`,
  'models/staging/stg_orders.sql': `${imports(cte('raw_orders', "ref('raw_orders')"))}
select
    order_id,
    customer_id,
    store_id,
    order_date,
    amount,
    status
from raw_orders
`,
  'models/staging/stg_stores.sql': `${imports(cte('raw_stores', "ref('raw_stores')"))}
select
    store_id,
    store_name,
    region,
    city
from raw_stores
`,
  'models/staging/stg_store_targets.sql': `${imports(cte('raw_store_targets', "ref('raw_store_targets')"))}
select
    store_id,
    target_month,
    target_amount
from raw_store_targets
`,
  'models/staging/stg_payments.sql': `${imports(cte('payments', "source('stripe', 'payments')"))}
select
    payment_id,
    order_id,
    amount / 100.0 as amount,
    created_at
from payments
`,
  'models/intermediate/int_orders_enriched.sql': `${imports(cte('stg_customers', "ref('stg_customers')"), cte('stg_orders', "ref('stg_orders')"))}
select
    stg_orders.order_id,
    stg_orders.order_date,
    stg_orders.store_id,
    stg_orders.amount,
    stg_orders.status,
    stg_customers.customer_id,
    stg_customers.customer_name
from stg_orders
inner join stg_customers
    on stg_orders.customer_id = stg_customers.customer_id
where stg_orders.status <> 'cancelled'
`,
  'models/intermediate/int_store_targets.sql': `${imports(cte('stg_stores', "ref('stg_stores')"), cte('stg_store_targets', "ref('stg_store_targets')"))}
select
    stg_stores.store_id,
    stg_stores.store_name,
    stg_stores.region,
    stg_stores.city,
    stg_store_targets.target_month,
    stg_store_targets.target_amount
from stg_stores
left join stg_store_targets
    on stg_stores.store_id = stg_store_targets.store_id
`,
  'models/marts/fct_sales.sql': `{{ config(materialized='table') }}

${imports(cte('int_orders_enriched', "ref('int_orders_enriched')"), cte('int_store_targets', "ref('int_store_targets')"))}
select
    int_orders_enriched.order_id,
    int_orders_enriched.order_date,
    int_orders_enriched.customer_name,
    int_orders_enriched.amount,
    int_orders_enriched.status,
    int_store_targets.store_name,
    int_store_targets.city,
    int_store_targets.target_amount
from int_orders_enriched
left join int_store_targets
    on int_orders_enriched.store_id = int_store_targets.store_id
`,
  'models/marts/dim_customers.sql': `{{ config(materialized='table') }}

${imports(cte('stg_customers', "ref('stg_customers')"), cte('int_orders_enriched', "ref('int_orders_enriched')"), cte('stg_payments', "ref('stg_payments')"))}
select
    stg_customers.customer_id,
    stg_customers.customer_name,
    count(int_orders_enriched.order_id) as orders,
    sum(stg_payments.amount) as lifetime_value
from stg_customers
left join int_orders_enriched using (customer_id)
left join stg_payments using (order_id)
group by 1, 2
`,
};

const COLUMNS = {
  fct_sales: [['order_id', 'bigint'], ['order_date', 'date'], ['customer_name', 'string'], ['amount', 'double'], ['status', 'string'], ['store_name', 'string'], ['city', 'string'], ['target_amount', 'bigint']],
  int_store_targets: [['store_id', 'bigint'], ['store_name', 'string'], ['region', 'string'], ['city', 'string'], ['target_month', 'string'], ['target_amount', 'bigint']],
};

function catalog() {
  const nodes = {};
  for (const [name, cols] of Object.entries(COLUMNS)) {
    nodes[`model.shop_analytics.${name}`] = {
      unique_id: `model.shop_analytics.${name}`,
      columns: Object.fromEntries(cols.map(([n, type], i) => [n, { name: n, type, index: i + 1 }])),
    };
  }
  return { metadata: {}, nodes, sources: {} };
}

/** Writes the project to a new folder. without: relative paths to leave out. */
function makeProject(root, { without = [] } = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(FILES)) {
    if (without.includes(rel)) continue;
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  fs.mkdirSync(path.join(root, 'target'), { recursive: true });
  fs.writeFileSync(path.join(root, 'target', 'catalog.json'), JSON.stringify(catalog()));
  return root;
}

// tpch_dbt names in the DAGtracer fixtures → names in this project.
const RENAME = [
  ['tpch_dbt', 'shop_analytics'],
  ['source1', 'stg_customers'],
  ['source2', 'stg_orders'],
  ['source3', 'stg_stores'],
  ['source4', 'stg_store_targets'],
  ['prep1', 'int_orders_enriched'],
  ['prep2', 'int_store_targets'],
  ['mart', 'fct_sales'],
];

function renameFixture(text) {
  let out = text;
  for (const [a, b] of RENAME) out = out.replace(new RegExp(`\\b${a}\\b`, 'g'), b);
  return out;
}

module.exports = { makeProject, renameFixture, FILES };
