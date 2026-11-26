export function respond(response, result) {
  const { status = 200, body, type = 'application/json; charset=utf-8', filename } = result
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`
  response.writeHead(status, headers)
  response.end(data)
}
