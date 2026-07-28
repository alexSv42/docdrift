# Projects API reference

Base URL: `https://api.example.com/v1`

## Create a project

`POST /v1/projects`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Display name. |
| `status` | string | no | One of `active`, `paused`, `completed`. Defaults to `active`. |

```bash
curl -X POST https://api.example.com/v1/projects \
  -H "X-Api-Key: $API_KEY" \
  -d '{"name":"Apollo"}'
```

## List projects

`GET /v1/projects`

| Query param | Type | Description |
| --- | --- | --- |
| `status` | string | Filter by status. |
| `perPage` | integer | Page size, 1–100. Defaults to 20. |
| `cursor` | string | Id of the last project on the previous page. |

Returns `{ "data": [...], "nextCursor": "prj_20" }`.

## Get a project

`GET /v1/projects/{id}` — returns a single project, or `404` if it does not exist.

## Update a project

`PATCH /v1/projects/{id}`

Accepts `name`, `status` and `isArchived`.

## The project object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | e.g. `prj_1`. |
| `name` | string | Display name. |
| `status` | string | `active`, `paused` or `completed`. |
| `isArchived` | boolean | Whether the project is archived. |
| `createdAt` | string | ISO 8601 timestamp. |
