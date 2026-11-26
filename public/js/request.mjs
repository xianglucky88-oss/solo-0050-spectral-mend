export async function request(operation, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }
  const response = await fetch(`/api/spectral-mend/${operation}`, options)
  if (!response.ok) {
    const payload = await response.json()
    throw new Error(payload.error)
  }
  return response.headers.get('content-type').startsWith('application/json')
    ? response.json() : response.blob()
}
