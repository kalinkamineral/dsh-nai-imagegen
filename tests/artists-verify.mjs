import { open, readFile } from 'node:fs/promises'
import { readArtistImage } from '../lib/artists.js'

// Independent count: how many records does the file actually contain?
const fh = await open('C:\\Users\\14552\\Downloads\\画师串9.28.json', 'r')
const buf = Buffer.alloc(8 * 1024 * 1024)
let needle = Buffer.from('"referenceImage"')
let tail = Buffer.alloc(0)
let hits = 0
let pos = 0
for (;;) {
  const r = await fh.read(buf, 0, buf.length, pos)
  if (r.bytesRead === 0) break
  const data = Buffer.concat([tail, buf.subarray(0, r.bytesRead)])
  let from = 0
  for (;;) {
    const i = data.indexOf(needle, from)
    if (i < 0) break
    hits += 1
    from = i + 1
  }
  tail = data.subarray(Math.max(0, data.length - needle.length))
  pos += r.bytesRead
}
await fh.close()
console.log(`文件中 "referenceImage" 出现次数：${hits}`)

const index = JSON.parse(await readFile('C:\\Users\\14552\\.dsh\\nai-imagegen\\artists\\index.json', 'utf8'))
console.log(`索引条目数：${index.entries.length}`)

// Verify the recorded byte ranges really do point at that entry's image.
for (const id of [0, 47, 95]) {
  const entry = index.entries[id]
  const png = await readArtistImage({ sourceFile: index.sourceFile, image: entry.image })
  const sigOk = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  console.log(`  #${id} ${entry.name}  png=${sigOk}  ${width}x${height}  ${(png.length / 1024 / 1024).toFixed(2)} MB`)
}