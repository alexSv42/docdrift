# Getting started

## Authentication

Every request must carry your API key in the `Authorization` header as a Bearer token.

```bash
curl https://api.example.com/v2/projects \
  -H "Authorization: Bearer $API_KEY"
```

## Your first project

```bash
curl -X POST https://api.example.com/v2/projects \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Apollo","ownerEmail":"owner@example.com"}'
```

## Paging

Pass `limit` to control the page size, then follow `nextCursor`:

```bash
curl "https://api.example.com/v2/projects?limit=50&cursor=prj_50" \
  -H "Authorization: Bearer $API_KEY"
```

## Next steps

See the [API reference](./api-reference.md) for every endpoint and field.
