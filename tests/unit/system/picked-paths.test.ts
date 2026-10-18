import { createPickedPaths } from '@main/core/system/picked-paths'

describe('picked paths', () => {
  it('knows the files picked, on Windows whatever their case', () => {
    const picked = createPickedPaths('win32')
    picked.add('C:\\Users\\Joueur\\Documents\\Tristan - Celeste.yaml')

    expect(picked.has('c:\\users\\joueur\\documents\\TRISTAN - CELESTE.yaml')).toBe(true)
    expect(picked.has('C:\\Users\\Joueur\\Documents\\host.yaml')).toBe(false)
  })

  it('knows the folders of the files picked, never the files themselves', () => {
    const picked = createPickedPaths('win32')
    picked.add('C:\\Users\\Joueur\\Documents\\Tristan - Celeste.yaml')
    picked.add('D:\\Player.yaml')

    expect(picked.isFolderOf('C:\\Users\\Joueur\\Documents')).toBe(true)
    // The same folder written another way: its case, a trailing separator, a dot segment.
    expect(picked.isFolderOf('c:\\users\\joueur\\DOCUMENTS\\')).toBe(true)
    expect(picked.isFolderOf('C:\\Users\\Joueur\\Documents\\.\\')).toBe(true)
    // A drive root is the folder of a file saved at its top.
    expect(picked.isFolderOf('D:\\')).toBe(true)

    expect(picked.isFolderOf('C:\\Users\\Joueur\\Documents\\Tristan - Celeste.yaml')).toBe(false)
    expect(picked.isFolderOf('C:\\Users\\Joueur')).toBe(false)
    expect(picked.isFolderOf('C:\\Users\\Joueur\\Documents\\Archipelago')).toBe(false)
    expect(picked.isFolderOf('C:\\')).toBe(false)
  })

  it('compares POSIX paths as they are written', () => {
    const picked = createPickedPaths('linux')
    picked.add('/home/joueur/Documents/Tristan - Celeste.yaml')

    expect(picked.isFolderOf('/home/joueur/Documents')).toBe(true)
    expect(picked.isFolderOf('/home/joueur/Documents/')).toBe(true)
    expect(picked.isFolderOf('/home/joueur/documents')).toBe(false)
    expect(picked.isFolderOf('/home/joueur')).toBe(false)
  })

  it('knows no folder before anything is picked', () => {
    expect(createPickedPaths('win32').isFolderOf('C:\\Users\\Joueur\\Documents')).toBe(false)
  })
})
