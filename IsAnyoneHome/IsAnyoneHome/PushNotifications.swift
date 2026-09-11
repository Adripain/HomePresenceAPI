import Foundation
import UIKit
import UserNotifications

enum PushEnvironment: String, Codable, Sendable {
    case sandbox
    case production

    static var current: PushEnvironment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }
}

enum AppLanguage {
    static var preferredIdentifier: String {
        Locale.preferredLanguages.first ?? "fr"
    }
}

enum PushTokenStorage {
    private static let key = "presence.push.token"

    static var token: String? {
        UserDefaults.standard.string(forKey: key)
    }

    static func save(_ deviceToken: Data) {
        UserDefaults.standard.set(deviceToken.map { String(format: "%02x", $0) }.joined(), forKey: key)
    }
}

extension Notification.Name {
    static let presencePushTokenDidChange = Notification.Name("presence.push-token-did-change")
}

final class PresenceAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushTokenStorage.save(deviceToken)
        NotificationCenter.default.post(name: .presencePushTokenDidChange, object: nil)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // A simulator or a temporary APNs failure must not be displayed as an
        // app error. The user can still use the app and try again later.
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
