# DAGtracer fixtures

Real `dgt -o json` output from the demo project `~/projects/dbt-lab/tpch_dbt`
(dgt 0.1.0, schema 1.0). Do not edit them by hand; make them again instead.

| File | Command |
|---|---|
| `dgt_mart_region.json` | `dgt mart -c region -o json` |
| `dgt_source1_region_down.json` | `dgt source1 -c region -d down -o json` |
| `dgt_source3_region_down.json` | `dgt source3 -c region -d down -o json` |
| `dgt_prep2_region_both.json` | `dgt prep2 -c region -d both -o json` |

To make them again (WSL, with the DAGtracer venv active):

```bash
cd ~/projects/dbt-lab/tpch_dbt
dbt build && dbt docs generate
dgt mart -c region -o json > target/dgt_mart_region.json
dgt source1 -c region -d down -o json > target/dgt_source1_region_down.json
dgt source3 -c region -d down -o json > target/dgt_source3_region_down.json
dgt prep2 -c region -d both -o json > target/dgt_prep2_region_both.json
cp target/dgt_*.json ~/projects/dbt-lens/test/fixtures/dagtracer/
```

What they show: `region` exists in source1, source3 and prep2. It stops in
prep1 (not selected from source1) and in mart (not selected from prep2).
