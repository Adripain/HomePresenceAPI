import Foundation

@MainActor
final class APIClient {
    private let vault: SessionVault
    private let baseURL: URL
    private let deviceID: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(vault: SessionVault) {
        self.vault = vault
        self.baseURL = AppConfiguration.apiBaseURL
        self.deviceID = InstallationIdentity.identifier
    }

    var isAuthenticated: Bool { vault.hasSession }

    func signIn(identityToken: String, displayName: String?) async throws {
        let body = AppleSignInRequest(identityToken: identityToken, deviceId: deviceID, displayName: displayName)
        let session: AuthSession = try await send(path: "/v1/auth/apple", method: "POST", bodyData: try encoder.encode(body), authenticated: false)
        try vault.save(session)
    }

    func signOut() async {
        _ = try? await request(path: "/v1/auth/session", method: "DELETE", bodyData: nil, authenticated: true)
        vault.clear()
    }

    func deleteAccount() async throws {
        _ = try await request(path: "/v1/account", method: "DELETE", bodyData: nil, authenticated: true)
        vault.clear()
    }

    func homes() async throws -> [PresenceHome] {
        let response: HomesResponse = try await send(path: "/v1/homes")
        return response.homes
    }

    func createHome(name: String, latitude: Double, longitude: Double, radiusMeters: Int) async throws -> PresenceHome {
        try await send(path: "/v1/homes", method: "POST", bodyData: try encoder.encode(CreateHomeRequest(name: name, latitude: latitude, longitude: longitude, radiusMeters: radiusMeters)))
    }

    func members(homeID: String) async throws -> [HomeMember] {
        let response: MembersResponse = try await send(path: "/v1/homes/\(homeID)/members")
        return response.members
    }

    func createInvitation(homeID: String, role: HomeRole) async throws -> InviteResult {
        try await send(path: "/v1/homes/\(homeID)/invitations", method: "POST", bodyData: try encoder.encode(InvitationRequest(role: role)))
    }

    func acceptInvitation(code: String) async throws -> PresenceHome {
        try await send(path: "/v1/invitations/accept", method: "POST", bodyData: try encoder.encode(AcceptInvitationRequest(code: code)))
    }

    func reportPresence(_ report: PresenceReport) async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let _: PresenceResponse = try await send(
            path: "/v1/homes/\(report.homeID)/presence",
            method: "POST",
            bodyData: try encoder.encode(PresenceRequest(eventId: report.id, deviceId: deviceID, isPresent: report.isPresent, source: report.source, observedAt: formatter.string(from: report.observedAt)))
        )
    }

    func notificationPreferences(homeID: String) async throws -> HomeNotificationPreferences {
        try await send(path: "/v1/homes/\(homeID)/notification-preferences")
    }

    func saveNotificationPreferences(homeID: String, preferences: HomeNotificationPreferences) async throws -> HomeNotificationPreferences {
        try await send(path: "/v1/homes/\(homeID)/notification-preferences", method: "PUT", bodyData: try encoder.encode(preferences))
    }

    func registerPushToken(_ token: String, environment: PushEnvironment, language: String) async throws {
        _ = try await request(
            path: "/v1/devices/push-token",
            method: "PUT",
            bodyData: try encoder.encode(PushTokenRequest(token: token, environment: environment, language: language)),
            authenticated: true
        )
    }

    func removePushToken() async {
        _ = try? await request(path: "/v1/devices/push-token", method: "DELETE", bodyData: nil, authenticated: true)
    }

    private func refreshSession() async throws {
        guard let oldSession = vault.session else { throw AppError.unauthorized }
        let session: AuthSession = try await send(
            path: "/v1/auth/refresh",
            method: "POST",
            bodyData: try encoder.encode(RefreshRequest(refreshToken: oldSession.refreshToken, deviceId: deviceID)),
            authenticated: false
        )
        try vault.save(session)
    }

    private func send<Response: Decodable>(path: String, method: String = "GET", bodyData: Data? = nil, authenticated: Bool = true) async throws -> Response {
        let data = try await request(path: path, method: method, bodyData: bodyData, authenticated: authenticated)
        return try decoder.decode(Response.self, from: data)
    }

    private func request(path: String, method: String, bodyData: Data?, authenticated: Bool) async throws -> Data {
        do {
            return try await perform(path: path, method: method, bodyData: bodyData, authenticated: authenticated)
        } catch AppError.unauthorized where authenticated {
            try await refreshSession()
            return try await perform(path: path, method: method, bodyData: bodyData, authenticated: true)
        }
    }

    private func perform(path: String, method: String, bodyData: Data?, authenticated: Bool) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw AppError.configuration }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            guard let token = vault.session?.accessToken else { throw AppError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AppError.invalidResponse }
        if http.statusCode == 401 { throw AppError.unauthorized }
        guard (200...299).contains(http.statusCode) else {
            let apiError = try? decoder.decode(ServerError.self, from: data)
            throw AppError.server(apiError?.message ?? "Le service a répondu avec l’erreur \(http.statusCode).")
        }
        return data
    }
}

private enum InstallationIdentity {
    static let identifier: String = {
        let key = "presence.installation.identifier"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let identifier = UUID().uuidString.lowercased()
        UserDefaults.standard.set(identifier, forKey: key)
        return identifier
    }()
}

private struct HomesResponse: Decodable { let homes: [PresenceHome] }
private struct MembersResponse: Decodable { let members: [HomeMember] }
private struct ServerError: Decodable {
    let error: String?
    let detail: String?

    var message: String? {
        (error ?? detail)?.replacingOccurrences(of: "_", with: " ").capitalized
    }
}
private struct AppleSignInRequest: Encodable { let identityToken: String; let deviceId: String; let displayName: String? }
private struct RefreshRequest: Encodable { let refreshToken: String; let deviceId: String }
private struct CreateHomeRequest: Encodable { let name: String; let latitude: Double; let longitude: Double; let radiusMeters: Int }
private struct InvitationRequest: Encodable { let role: HomeRole }
private struct AcceptInvitationRequest: Encodable { let code: String }
private struct PresenceRequest: Encodable { let eventId: String; let deviceId: String; let isPresent: Bool; let source: PresenceSource; let observedAt: String }
private struct PushTokenRequest: Encodable { let token: String; let environment: PushEnvironment; let language: String }
private struct PresenceResponse: Decodable { let accepted: Bool }
