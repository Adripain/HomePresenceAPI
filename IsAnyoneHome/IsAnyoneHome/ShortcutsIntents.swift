import AppIntents
import Foundation

struct GetHomeStatusIntent: AppIntent {
    static var title: LocalizedStringResource { "Obtenir l’état du domicile" }
    static var description = IntentDescription("Renvoie le nombre de personnes actuellement présentes dans un domicile.")
    static var openAppWhenRun = false

    @Parameter(title: "Domicile") var home: PresenceHomeEntity?

    init() { }

    init(home: PresenceHomeEntity?) {
        self.home = home
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Obtenir l’état de \(\.$home)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Int> {
        guard let home else {
            throw AppError.server(PresenceL10n.text("error.choose_home", fallback: "Choisissez un domicile."))
        }
        let store = await AppStore()
        let homes = try await store.homesForSystemAction()
        guard let freshHome = homes.first(where: { $0.id == home.id }) else {
            throw AppError.server(PresenceL10n.text("error.home_unavailable", fallback: "Ce domicile n’est plus accessible."))
        }
        let dialog = if freshHome.presentCount == 0 {
            PresenceL10n.format("shortcut.home_empty", fallback: "Personne n’est présente dans %@.", freshHome.name)
        } else if freshHome.presentCount == 1 {
            PresenceL10n.format("shortcut.home_count.one", fallback: "%lld personne présente dans %@.", freshHome.presentCount, freshHome.name)
        } else {
            PresenceL10n.format("shortcut.home_count.many", fallback: "%lld personnes présentes dans %@.", freshHome.presentCount, freshHome.name)
        }
        return .result(
            value: freshHome.presentCount,
            dialog: IntentDialog(stringLiteral: dialog)
        )
    }
}

struct PresenceAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetHomeStatusIntent(),
            phrases: ["Obtenir l’état du domicile dans \(.applicationName)"],
            shortTitle: "État du domicile",
            systemImageName: "house"
        )
    }
}
