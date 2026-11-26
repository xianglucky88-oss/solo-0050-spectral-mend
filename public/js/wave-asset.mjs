export function fromFile(file) {
  if (file.size > 1200000) return Promise.reject(new Error('音频文件超出大小限制。'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = () => reject(new Error('无法读取音频文件。'))
    reader.readAsDataURL(file)
  })
}

export function wavBlob(base64) {
  return new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'audio/wav' })
}
