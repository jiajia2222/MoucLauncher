/**
 * Default SecretCipher for production: Electron `safeStorage` (Windows DPAPI).
 * Imported dynamically by the account service so tests (and any code path that
 * injects its own cipher) never load Electron.
 */
import { safeStorage } from 'electron'
import { AppError } from '@shared/errors'
import type { SecretCipher } from './store'

const PREFIX = 'safe:v1:'

function availableOrThrow(): void {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    throw new AppError('config', '系统加密不可用，无法保存登录令牌', 'Electron safeStorage 未就绪（Windows 上通常由 DPAPI 提供）')
  }
}

export function createElectronCipher(): SecretCipher {
  return {
    encrypt(plain: string): string {
      availableOrThrow()
      return PREFIX + safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(cipherText: string): string {
      if (!cipherText.startsWith(PREFIX)) {
        throw new AppError('config', '账户密文格式不正确', '期望 safe:v1: 前缀的 safeStorage 密文')
      }
      availableOrThrow()
      return safeStorage.decryptString(Buffer.from(cipherText.slice(PREFIX.length), 'base64'))
    }
  }
}

export default createElectronCipher
