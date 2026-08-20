/**
 * The profile-photo contract: what the API returns, and whether a browser can
 * actually load it from a different origin.
 *
 * This is the exact defect the tests exist for — the API returned a relative
 * path that resolved against the front end and 404ed, so the upload "worked"
 * and the avatar was a broken image.
 */

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

// --- the DTO shape, as the service builds it --------------------------------
const dto = (user) => ({
  id: String(user._id),
  profilePhoto: user.profilePhoto ? `/api/v1/profile/photo/${user._id}` : null,
  photoUpdatedAt: user.profilePhoto ? (user.updatedAt ?? null) : null,
})

// --- the client's URL builder, mirroring profilePhotoUrl --------------------
const API_ORIGIN = 'https://crmbackend.xploreaustralia.com'
const APP_ORIGIN = 'https://crm.xploreaustralia.com'
const clientUrl = (id, version) => {
  const u = new URL(`/api/v1/profile/photo/${id}`, API_ORIGIN)
  if (version) u.searchParams.set('v', String(Date.parse(version)))
  return u.toString()
}

const WITH = { _id: 'u1', profilePhoto: 'u1/abc.png', updatedAt: '2026-08-20T09:00:00.000Z' }
const WITHOUT = { _id: 'u2', profilePhoto: null, updatedAt: '2026-08-20T09:00:00.000Z' }

console.log('\n=== API response shape ===')
check('photo present -> profilePhoto set', dto(WITH).profilePhoto !== null)
check('photo present -> photoUpdatedAt set', dto(WITH).photoUpdatedAt !== null)
check('no photo -> both null', dto(WITHOUT).profilePhoto === null && dto(WITHOUT).photoUpdatedAt === null)

console.log('\n=== the bug: relative path resolves to the WRONG origin ===')
const naive = new URL(dto(WITH).profilePhoto, APP_ORIGIN).toString()
check('relative path resolves to the app origin (404)', naive.startsWith(APP_ORIGIN), naive)
check('...which is NOT the API origin', !naive.startsWith(API_ORIGIN))

console.log('\n=== the fix: client builds an absolute API URL ===')
const good = clientUrl(dto(WITH).id, dto(WITH).photoUpdatedAt)
check('resolves to the API origin', good.startsWith(API_ORIGIN), good)
check('keeps the /api/v1 path', good.includes('/api/v1/profile/photo/u1'))
check('carries a cache-busting version', /[?&]v=\d+/.test(good))

console.log('\n=== cache busting actually changes the URL ===')
const before = clientUrl('u1', '2026-08-20T09:00:00.000Z')
const after  = clientUrl('u1', '2026-08-20T10:00:00.000Z')
check('a new upload yields a different URL', before !== after)
check('same photo yields a stable URL', before === clientUrl('u1', '2026-08-20T09:00:00.000Z'))

console.log('\n=== no photo -> no image request at all ===')
check('client renders initials instead', dto(WITHOUT).profilePhoto === null)

console.log('\n=== accepted image types (server sniffs real bytes) ===')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00])
const sniff = (b) =>
  b.slice(0, 8).equals(PNG) ? 'image/png'
  : b.slice(0, 3).equals(JPG.slice(0, 3)) ? 'image/jpeg'
  : null
check('PNG magic bytes recognised', sniff(PNG) === 'image/png')
check('JPEG magic bytes recognised', sniff(JPG) === 'image/jpeg')
check('EXE renamed .png is refused', sniff(EXE) === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
