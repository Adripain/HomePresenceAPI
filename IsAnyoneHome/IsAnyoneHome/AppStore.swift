import Combine
import Foundation
import UIKit
import UserNotifications
import WidgetKit

@MainActor
final class AppStore: ObservableObject {
    @Published private(set) var homes: [PresenceHome] = []
    @Published var selectedHomeID: String?
    @Published var errorMessage: String?
    @Published private(set) var isLoading = false
    /// Changes whenever the server has accepted a local arrival/departure.
    /// Views use it to immediately refresh their member list.
    @Published private(set) var presenceRevision = 0

    let location = LocationService()
    private let vault: SessionVault
    private let api: APIClient
    private let presenceOutbox = PresenceOutbox()
    private var pushTokenObserver: NSObjectProtocol?

    init() {
        let vault = SessionVault()
        self.vault = vault
        self.api = APIClient(vault: vault)
        self.selectedHomeID = UserDefaults.standard.string(forKey: "presence.selected.home")
        location.onPresenceChange = { [weak self] report in
            Task { @MainActor [weak self] in
                self?.presenceOutbox.append(report)
                await self?.flushPresenceOutbox()
            }
        }
        pushTokenObserver = NotificationCenter.default.addObserver(
            forName: .presencePushTokenDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.registerStoredPushToken()
            }
        }
    }

    var isAuthenticated: Bool { api.isAuthenticated }

    var selectedHome: PresenceHome? {
        homes.first { $0.id == selectedHomeID } ?? homes.first
    }

    func bootstrap() async {
        guard isAuthenticated else { return }
        await reloadHomes()
        await registerStoredPushToken()
    }

    func signIn(identityToken: String, displayName: String?) async {
        isLoading = true
        defer { isLoading = false }
        do {
            try await api.signIn(identityToken: identityToken, displayName: displayName)
            await reloadHomes()
            await registerStoredPushToken()
        } catch {
            present(error)
        }
    }

    func signOut() async {
        await api.removePushToken()
        await api.signOut()
        homes = []
        selectedHomeID = nil
        UserDefaults.standard.removeObject(forKey: "presence.selected.home")
        clearWidgetHomes()
    }

    func deleteAccount() async -> Bool {
        do {
            try await api.deleteAccount()
            homes = []
            selectedHomeID = nil
            UserDefaults.standard.removeObject(forKey: "presence.selected.home")
            clearWidgetHomes()
            return true
        } catch {
            present(error)
            return false
        }
    }

    func reloadHomes(silently: Bool = false) async {
        if !silently { isLoading = true }
        defer { if !silently { isLoading = false } }
        do {
            homes = try await api.homes()
            updateWidgetHomes()
            if selectedHome == nil { select(homes.first?.id) }
            location.configureMonitoring(homes: homes)
            await flushPresenceOutbox()
        } catch {
            if case AppError.unauthorized = error {
                vault.clear()
                clearWidgetHomes()
            }
            if !silently { present(error) }
        }
    }

    func select(_ id: String?) {
        selectedHomeID = id
        if let id { UserDefaults.standard.set(id, forKey: "presence.selected.home") }
    }

    func createHome(name: String, latitude: Double, longitude: Double, radiusMeters: Int) async -> Bool {
        do {
            let home = try await api.createHome(name: name, latitude: latitude, longitude: longitude, radiusMeters: radiusMeters)
            homes.append(home)
            updateWidgetHomes()
            select(home.id)
            location.configureMonitoring(homes: homes)
            return true
        } catch {
            present(error)
            return false
        }
    }

    func acceptInvitation(code: String) async -> Bool {
        do {
            let home = try await api.acceptInvitation(code: code)
            homes.append(home)
            updateWidgetHomes()
            select(home.id)
            location.configureMonitoring(homes: homes)
            return true
        } catch {
            present(error)
            return false
        }
    }

    func members(for home: PresenceHome) async throws -> [HomeMember] {
        try await api.members(homeID: home.id)
    }

    func invite(home: PresenceHome, role: HomeRole) async throws -> InviteResult {
        try await api.createInvitation(homeID: home.id, role: role)
    }

    func notificationPreferences(for home: PresenceHome) async throws -> HomeNotificationPreferences {
        try await api.notificationPreferences(homeID: home.id)
    }

    func saveNotificationPreferences(_ preferences: HomeNotificationPreferences, for home: PresenceHome) async throws -> HomeNotificationPreferences {
        try await api.saveNotificationPreferences(homeID: home.id, preferences: preferences)
    }

    func requestNotificationPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        let granted: Bool
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            granted = true
        case .notDetermined:
            granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true
        case .denied:
            granted = false
        @unknown default:
            granted = false
        }
        guard granted else { return false }
        UIApplication.shared.registerForRemoteNotifications()
        await registerStoredPushToken()
        return true
    }

    func present(_ error: Error) {
        errorMessage = error.localizedDescription
    }

    func homesForSystemAction() async throws -> [PresenceHome] {
        guard isAuthenticated else { throw AppError.unauthorized }
        let refreshedHomes = try await api.homes()
        homes = refreshedHomes
        updateWidgetHomes()
        return refreshedHomes
    }

    private func flushPresenceOutbox() async {
        presenceOutbox.discardExpired()
        var sentPresence = false
        for report in presenceOutbox.pending {
            do {
                try await api.reportPresence(report)
                presenceOutbox.remove(id: report.id)
                sentPresence = true
            } catch {
                // Preserve ordering. The next foregrounding or Core Location wake-up retries it.
                break
            }
        }
        guard sentPresence else { return }

        // The API has accepted the new state, so reflect both the occupancy
        // count and the individual member state without requiring an app relaunch.
        await reloadHomes(silently: true)
        presenceRevision &+= 1
    }

    private func updateWidgetHomes() {
        let refreshedAt = Date()
        PresenceSharedStore.save(homes.map {
            PresenceWidgetHome(id: $0.id, name: $0.name, presentCount: $0.presentCount, refreshedAt: refreshedAt)
        })
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func clearWidgetHomes() {
        PresenceSharedStore.clear()
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func registerStoredPushToken() async {
        guard isAuthenticated, let token = PushTokenStorage.token else { return }
        try? await api.registerPushToken(token, environment: .current, language: AppLanguage.preferredIdentifier)
    }
}
