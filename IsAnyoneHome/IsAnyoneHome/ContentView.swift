//
//  ContentView.swift
//  IsAnyoneHome
//
//  Created by Adrien de Trazegnies d'iTTRE on 07/09/2026.
//

import AuthenticationServices
import SwiftUI

struct ContentView: View {
    @ObservedObject var store: AppStore

    var body: some View {
        Group {
            if store.isAuthenticated {
                HomeListView(store: store)
            } else {
                WelcomeView(store: store)
            }
        }
        .task { await store.bootstrap() }
        .alert("Une action demande votre attention", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }
}

private struct WelcomeView: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "house.and.flag.fill")
                .font(.system(size: 62, weight: .medium))
                .foregroundStyle(.indigo)
            VStack(spacing: 10) {
                Text("Présence")
                    .font(.largeTitle.bold())
                Text("Des domiciles qui s’adaptent à ceux qui sont là.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            SignInWithAppleButton(.signIn, onRequest: { request in
                request.requestedScopes = [.fullName]
            }, onCompletion: { result in
                switch result {
                case .success(let authorization):
                    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                          let tokenData = credential.identityToken,
                          let token = String(data: tokenData, encoding: .utf8) else {
                        Task { @MainActor in
                            store.errorMessage = PresenceL10n.text("error.identity_unverified", fallback: "L’identité n’a pas pu être vérifiée.")
                        }
                        return
                    }
                    let displayName = [credential.fullName?.givenName, credential.fullName?.familyName]
                        .compactMap { $0 }
                        .joined(separator: " ")
                    Task { await store.signIn(identityToken: token, displayName: displayName.isEmpty ? nil : displayName) }
                case .failure(let error):
                    // Cancelling the system sheet is a normal outcome. In
                    // particular, iOS can cancel a stale request while the app
                    // is becoming active again; presenting it as an app error
                    // on the next launch is confusing.
                    if let authorizationError = error as? ASAuthorizationError,
                       authorizationError.code == .canceled {
                        return
                    }
                    Task { @MainActor in store.present(error) }
                }
            })
            .signInWithAppleButtonStyle(.black)
            .frame(maxWidth: 375)
            .frame(height: 50)
            .padding(.top, 12)
            Text("Choisissez l’autorisation de position « Toujours » pour détecter les arrivées et les départs, même lorsque l’app est fermée. Votre position exacte ne quitte pas votre téléphone lors des vérifications courantes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(32)
        .overlay {
            if store.isLoading { ProgressView().controlSize(.large) }
        }
    }
}
