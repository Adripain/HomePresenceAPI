import AppIntents
import Foundation

enum PresenceL10n {
    nonisolated static func text(_ key: String, fallback: String) -> String {
        NSLocalizedString(key, bundle: .main, value: fallback, comment: "")
    }

    nonisolated static func format(_ key: String, fallback: String, _ arguments: CVarArg...) -> String {
        String(format: text(key, fallback: fallback), locale: .current, arguments: arguments)
    }

    nonisolated static func presentCount(_ count: Int) -> String {
        if count == 0 {
            return text("presence.count.none", fallback: "Personne n’est présente")
        }
        if count == 1 {
            return format("presence.count.one", fallback: "%lld personne présente", count)
        }
        return format("presence.count.many", fallback: "%lld personnes présentes", count)
    }

    nonisolated static func memberStatus(_ isPresent: Bool) -> String {
        text(isPresent ? "member.present" : "member.absent", fallback: isPresent ? "Présent" : "Absent")
    }
}

/// The only data shared with the widget: a home name, its occupancy count and
/// when the app last refreshed it. No member identities or location data leave
/// the main application through this store.
struct PresenceWidgetHome: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let presentCount: Int
    let refreshedAt: Date
}

enum PresenceSharedStore {
    static let appGroupIdentifier = "group.adriendtz.isanyonehome"

    private static let homesKey = "presence.widget.homes.v1"

    static func homes() -> [PresenceWidgetHome] {
        guard let data = defaults.data(forKey: homesKey),
              let homes = try? JSONDecoder().decode([PresenceWidgetHome].self, from: data) else {
            return []
        }
        return homes
    }

    static func save(_ homes: [PresenceWidgetHome]) {
        defaults.set(try? JSONEncoder().encode(homes), forKey: homesKey)
    }

    static func clear() {
        defaults.removeObject(forKey: homesKey)
    }

    private static var defaults: UserDefaults {
        // The fallback keeps previews and unit tests usable. On device, both
        // targets use the App Group container declared in their entitlements.
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }
}

struct PresenceHomeEntity: AppEntity {
    typealias ID = String

    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Domicile" }
    static var defaultQuery = PresenceHomeEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct PresenceHomeEntityQuery: EntityQuery {
    func entities(for identifiers: [PresenceHomeEntity.ID]) async throws -> [PresenceHomeEntity] {
        let identifiers = Set(identifiers)
        return entities.filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [PresenceHomeEntity] {
        entities
    }

    func defaultResult() async -> PresenceHomeEntity? {
        entities.first
    }

    private var entities: [PresenceHomeEntity] {
        PresenceSharedStore.homes().map { PresenceHomeEntity(id: $0.id, name: $0.name) }
    }
}

struct SelectPresenceHomeIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Choisir un domicile" }
    static var description: IntentDescription { "Affiche le nombre de personnes présentes dans le domicile choisi." }

    @Parameter(title: "Domicile") var home: PresenceHomeEntity?

    init() { }

    init(home: PresenceHomeEntity?) {
        self.home = home
    }
}
