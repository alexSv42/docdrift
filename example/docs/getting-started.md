# Getting started

## Authentication

Every request must carry your API key in the `Authorization` header using the `Bearer` scheme.

```bash
curl https://api.example.com/v4/projects \
  -H "Authorization: Bearer $API_KEY"
```

## Your first project

```bash
curl -X POST https://api.example.com/v4/projects \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Apollo","ownerEmail":"owner@example.com"}'
```

## Fetching, updating, and deleting a project

```bash
curl https://api.example.com/v4/projects/prj_1 \
  -H "Authorization: Bearer $API_KEY"
```

```bash
curl -X PATCH https://api.example.com/v4/projects/prj_1 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"archived":true}'
```

```bash
curl -X DELETE https://api.example.com/v4/projects/prj_1 \
  -H "Authorization: Bearer $API_KEY"
```

## Paging

Pass `limit` to control the page size, then follow `nextCursor`:

```bash
curl "https://api.example.com/v4/projects?limit=50&cursor=prj_50" \
  -H "Authorization: Bearer $API_KEY"
```

## Next steps

See the [API reference](./api-reference.md) for every endpoint and field.
