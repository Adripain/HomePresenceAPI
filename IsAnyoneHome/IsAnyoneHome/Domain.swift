import Foundation

enum AppConfiguration {
    static let apiBaseURL: URL = {
        guard let rawValue = Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String,
              let url = URL(string: rawValue),
              url.scheme == "https" else {
            fatalError("Configure a valid HTTPS APIBaseURL in Info.plist")
        }
        return url
    }()
}

struct AuthSession: Codable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
}

struct PresenceHome: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let latitude: Double
    let longitude: Double
    let radiusMeters: Int
    let role: HomeRole
    let presentCount: Int
}

enum HomeRole: String, Codable, CaseIterable, Sendable {
    case owner, admin, member

    var label: String {
        switch self {
        case .owner: PresenceL10n.text("role.owner", fallback: "Propriétaire")
        case .admin: PresenceL10n.text("role.admin", fallback: "Administrateur")
        case .member: PresenceL10n.text("role.member", fallback: "Membre")
        }
    }

    var canManage: Bool { self != .member }
}

struct HomeMember: Codable, Identifiable, Sendable {
    let id: String
    let displayName: String
    let role: HomeRole
    let isPresent: Bool
    let observedAt: String?
}

struct HomeNotificationPreferences: Codable, Sendable, Equatable {
    var arrivals: Bool
    var departures: Bool
    var homeEmpty: Bool

    static let none = HomeNotificationPreferences(arrivals: false, departures: false, homeEmpty: false)
}

struct InviteResult: Codable, Sendable {
    let code: String
    let expiresAt: String
}

struct PresenceReport: Codable, Identifiable, Sendable {
    let id: String
    let homeID: String
    let isPresent: Bool
    let source: PresenceSource
    let observedAt: Date
}

enum PresenceSource: String, Codable, Sendable {
    case regionEnter = "region_enter"
    case regionExit = "region_exit"
    case heartbeat
}

enum AppError: LocalizedError {
    case configuration
    case unauthorized
    case server(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .configuration: PresenceL10n.text("error.configuration", fallback: "L’adresse du service n’est pas configurée.")
        case .unauthorized: PresenceL10n.text("error.unauthorized", fallback: "Votre session a expiré. Connectez-vous à nouveau.")
        case .server(let message): message
        case .invalidResponse: PresenceL10n.text("error.invalid_response", fallback: "Le service a renvoyé une réponse inattendue.")
        }
    }
}
