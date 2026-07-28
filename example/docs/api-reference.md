# Projects API reference

Base URL: `https://api.example.com/v3`

## Authentication

All endpoints require a bearer token in the `Authorization` header:

```bash
curl https://api.example.com/v3/projects \
  -H "Authorization: Bearer $API_KEY"
```

## Create a project

`POST /v3/projects`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Display name. |
| `ownerEmail` | string | yes | Email address of the project owner. |
| `status` | string | no | One of `active`, `paused`, `completed`. Defaults to `active`. |

```bash
curl -X POST https://api.example.com/v3/projects \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"Apollo","ownerEmail":"owner@example.com"}'
```

## List projects

`GET /v3/projects`

| Query param | Type | Description |
| --- | --- | --- |
| `status` | string | Filter by status. |
| `limit` | integer | Page size, 1–100. Defaults to 20. |
| `cursor` | string | Id of the last project on the previous page. |

Returns `{ "data": [...], "nextCursor": "prj_20" }`.

```bash
curl "https://api.example.com/v3/projects?limit=50" \
  -H "Authorization: Bearer $API_KEY"
```

## Get a project

`GET /v3/projects/{id}` — returns a single project, or `404` if it does not exist.

```bash
curl https://api.example.com/v3/projects/prj_1 \
  -H "Authorization: Bearer $API_KEY"
```

## Update a project

`PATCH /v3/projects/{id}`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | no | Display name. |
| `status` | string | no | One of `active`, `paused`, `completed`. |
| `archived` | boolean | no | Whether the project is archived. |

```bash
curl -X PATCH https://api.example.com/v3/projects/prj_1 \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"archived":true}'
```

## Delete a project

`DELETE /v3/projects/{id}` — returns `204` on success.

```bash
curl -X DELETE https://api.example.com/v3/projects/prj_1 \
  -H "Authorization: Bearer $API_KEY"
```

## The project object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | e.g. `prj_1`. |
| `name` | string | Display name. |
| `ownerEmail` | string | Email address of the project owner. |
| `status` | string | `active`, `paused` or `completed`. |
| `archived` | boolean | Whether the project is archived. |
| `createdAt` | string | ISO 8601 timestamp. |
