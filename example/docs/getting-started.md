# Getting started

## Authentication

Every request must carry your API key in the `X-Api-Key` header.

```bash
curl https://api.example.com/v1/projects \
  -H "X-Api-Key: $API_KEY"
```

## Your first project

```bash
curl -X POST https://api.example.com/v1/projects \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Apollo"}'
```

## Paging

Pass `perPage` to control the page size, then follow `nextCursor`:

```bash
curl "https://api.example.com/v1/projects?perPage=50&cursor=prj_50" \
  -H "X-Api-Key: $API_KEY"
```

## Next steps

See the [API reference](./api-reference.md) for every endpoint and field.
