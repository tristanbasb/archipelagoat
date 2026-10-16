import pkg from '../../package.json'

it('identifies the app', () => {
  expect(pkg.name).toBe('archipelagoat')
  expect(pkg.productName).toBe('ArchipelaGOAT')
  expect(pkg.main).toBe('./out/main/index.js')
})
