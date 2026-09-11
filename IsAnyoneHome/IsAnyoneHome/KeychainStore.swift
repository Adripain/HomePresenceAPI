import Foundation
import Security

@MainActor
final class SessionVault {
    private let service = "com.adriendtz.isanyonehome.session"
    private let account = "current-user"
    private(set) var session: AuthSession?

    init() {
        session = try? read()
    }

    var hasSession: Bool { session != nil }

    func save(_ newSession: AuthSession) throws {
        let data = try JSONEncoder().encode(newSession)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        SecItemDelete(query as CFDictionary)
        let attributes: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let result = SecItemAdd(attributes as CFDictionary, nil)
        guard result == errSecSuccess else { throw AppError.configuration }
        session = newSession
    }

    func clear() {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        SecItemDelete(query as CFDictionary)
        session = nil
    }

    private func read() throws -> AuthSession? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw AppError.configuration }
        return try JSONDecoder().decode(AuthSession.self, from: data)
    }
}
