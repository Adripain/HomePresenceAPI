//
//  IsAnyoneHomeApp.swift
//  IsAnyoneHome
//
//  Created by Adrien de Trazegnies d'iTTRE on 07/09/2026.
//

import SwiftUI

@main
struct IsAnyoneHomeApp: App {
    @UIApplicationDelegateAdaptor(PresenceAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
        }
    }
}
