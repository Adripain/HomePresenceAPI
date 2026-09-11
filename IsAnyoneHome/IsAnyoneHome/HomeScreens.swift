import CoreLocation
import Foundation
import SwiftUI
import AppIntents

struct HomeListView: View {
    @ObservedObject var store: AppStore
    @State private var showCreateHome = false
    @State private var showJoinHome = false
    @State private var showAccountDeletion = false
    @State private var showShortcutsGuide = false

    var body: some View {
        NavigationStack {
            Group {
                if let home = store.selectedHome {
                    HomeDashboard(store: store, location: store.location, home: home)
                } else if store.isLoading {
                    ProgressView("Chargement des domiciles…")
                } else {
                    ContentUnavailableView(
                        "Aucun domicile",
                        systemImage: "house",
                        description: Text("Créez votre premier domicile ou rejoignez-en un avec une invitation.")
                    )
                }
            }
            .navigationTitle("Présence")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !store.homes.isEmpty {
                        Menu {
                            Picker("Domicile", selection: Binding(
                                get: { store.selectedHome?.id ?? "" },
                                set: { store.select($0) }
                            )) {
                                ForEach(store.homes) { home in
                                    Text(home.name).tag(home.id)
                                }
                            }
                        } label: {
                            Label("Changer de domicile", systemImage: "house.fill")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showCreateHome = true } label: {
                            Label("Créer un domicile", systemImage: "plus")
                        }
                        Button { showJoinHome = true } label: {
                            Label("Rejoindre avec un code", systemImage: "person.badge.plus")
                        }
                        Button { showShortcutsGuide = true } label: {
                            Label("Intégrer Raccourcis", systemImage: "bolt.horizontal.circle")
                        }
                        Divider()
                        Button(role: .destructive) {
                            Task { await store.signOut() }
                        } label: {
                            Label("Se déconnecter", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                        Button(role: .destructive) { showAccountDeletion = true } label: {
                            Label("Supprimer mon compte", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .sheet(isPresented: $showCreateHome) {
                CreateHomeSheet(store: store, location: store.location)
            }
            .sheet(isPresented: $showJoinHome) {
                JoinHomeSheet(store: store)
            }
            .sheet(isPresented: $showShortcutsGuide) {
                ShortcutsGuideSheet()
            }
            .confirmationDialog("Supprimer votre compte ?", isPresented: $showAccountDeletion, titleVisibility: .visible) {
                Button("Supprimer définitivement", role: .destructive) {
                    Task { _ = await store.deleteAccount() }
                }
                Button("Annuler", role: .cancel) { }
            } message: {
                Text("Vos domiciles sans autre membre seront supprimés. Les domiciles partagés seront transférés à un autre membre. Cette action est irréversible.")
            }
            .refreshable { await store.reloadHomes() }
        }
    }
}

private struct ShortcutsGuideSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Créer une automatisation") {
                    Label("Dans Raccourcis, ouvrez Automatisation puis créez une automatisation personnelle.", systemImage: "1.circle")
                    Label("Choisissez par exemple « Wi-Fi », puis le réseau de votre domicile.", systemImage: "2.circle")
                    Label("Ajoutez l’action « Obtenir l’état du domicile » de Présence et choisissez le domicile.", systemImage: "3.circle")
                    Label("Ajoutez une condition : si le nombre renvoyé est égal à 0, exécutez les actions de votre choix.", systemImage: "4.circle")
                }
                Section("À savoir") {
                    Text("Cette automatisation appartient à votre iPhone. Chaque membre qui souhaite automatiser ses appareils crée la sienne dans Raccourcis.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section {
                    ShortcutsLink()
                        .shortcutsLinkStyle(.automatic)
                } footer: {
                    Text("Le bouton ouvre la page Présence dans l’app Raccourcis, où l’action est disponible.")
                }
            }
            .navigationTitle("Raccourcis")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
        }
    }
}

private struct HomeDashboard: View {
    @ObservedObject var store: AppStore
    @ObservedObject var location: LocationService
    let home: PresenceHome
    @State private var members: [HomeMember] = []
    @State private var notificationPreferences = HomeNotificationPreferences.none
    @State private var hasLoadedNotificationPreferences = false
    @State private var showInvite = false

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(home.name).font(.title2.bold())
                            Label(
                                PresenceL10n.presentCount(home.presentCount),
                                systemImage: home.presentCount == 0 ? "house" : "person.2.fill"
                            )
                            .foregroundStyle(home.presentCount == 0 ? Color.secondary : Color.green)
                        }
                        Spacer()
                        Text(home.role.label)
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 8).padding(.vertical, 5)
                            .background(.quaternary, in: Capsule())
                    }
                    if let status = location.statusMessage {
                        Label(status, systemImage: "location.slash")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    } else if !location.hasAlwaysPermission {
                        Button("Autoriser la position « Toujours »") {
                            location.requestAlwaysPermission()
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    if !members.isEmpty {
                        let presentMembers = members.filter(\.isPresent)
                        Divider()
                        if presentMembers.isEmpty {
                            Label("Aucun membre n’est présent", systemImage: "person")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            Label(
                                presentMembers.map(\.displayName).joined(separator: ", "),
                                systemImage: "person.fill.checkmark"
                            )
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.green)
                            .lineLimit(2)
                        }
                    }
                }
                .padding(.vertical, 6)
            }

            Section("Notifications") {
                Toggle("Lorsqu’une personne arrive", isOn: $notificationPreferences.arrivals)
                Toggle("Lorsqu’une personne part", isOn: $notificationPreferences.departures)
                Toggle("Lorsque le domicile devient vide", isOn: $notificationPreferences.homeEmpty)
                Button("Autoriser les notifications sur cet iPhone") {
                    Task {
                        if !(await store.requestNotificationPermission()) {
                            store.errorMessage = PresenceL10n.text(
                                "notifications.disabled",
                                fallback: "Les notifications sont désactivées. Activez-les dans Réglages > Présence > Notifications."
                            )
                        }
                    }
                }
                Text("Ces choix ne concernent que votre compte. Les alertes sont envoyées sur les appareils où vous les avez autorisées.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Membres") {
                if members.isEmpty {
                    Text("Chargement…").foregroundStyle(.secondary)
                } else {
                    ForEach(members) { member in
                        HStack {
                            Image(systemName: member.isPresent ? "person.fill.checkmark" : "person")
                                .foregroundStyle(member.isPresent ? .green : .secondary)
                            VStack(alignment: .leading) {
                                Text(member.displayName)
                                Text(member.role.label).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(PresenceL10n.memberStatus(member.isPresent))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(member.isPresent ? .green : .secondary)
                        }
                    }
                }
                if home.role.canManage {
                    Button { showInvite = true } label: {
                        Label("Inviter un membre", systemImage: "person.badge.plus")
                    }
                }
            }
        }
        .task(id: "\(home.id)-\(store.presenceRevision)") { await load() }
        .task(id: home.id) { await refreshPresenceWhileVisible() }
        .sheet(isPresented: $showInvite) { InviteSheet(store: store, home: home) }
        .onChange(of: notificationPreferences) { _, _ in
            guard hasLoadedNotificationPreferences else { return }
            Task { await saveNotificationPreferences() }
        }
    }

    private func load() async {
        do {
            async let loadedMembers = store.members(for: home)
            async let loadedPreferences = store.notificationPreferences(for: home)
            members = try await loadedMembers
            notificationPreferences = try await loadedPreferences
            hasLoadedNotificationPreferences = true
        } catch {
            store.present(error)
        }
    }

    private func saveNotificationPreferences() async {
        do {
            notificationPreferences = try await store.saveNotificationPreferences(notificationPreferences, for: home)
        } catch {
            store.present(error)
        }
    }

    private func refreshPresenceWhileVisible() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled else { return }
            await store.reloadHomes(silently: true)
            do {
                members = try await store.members(for: home)
            } catch {
                // A temporary network error should not interrupt the dashboard.
            }
        }
    }
}

private struct CreateHomeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: AppStore
    @ObservedObject var location: LocationService
    @State private var name = ""
    @State private var radius = 150.0
    @State private var latitude: Double?
    @State private var longitude: Double?
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Nouveau domicile") {
                    TextField("Nom", text: $name)
                    Stepper(
                        PresenceL10n.format("home.radius", fallback: "Rayon : %lld m", Int(radius)),
                        value: $radius,
                        in: 100...1_000,
                        step: 25
                    )
                }
                Section("Position") {
                    if let latitude, let longitude {
                        LabeledContent("Position actuelle", value: "\(latitude.formatted(.number.precision(.fractionLength(5)))), \(longitude.formatted(.number.precision(.fractionLength(5))))")
                    } else {
                        Text("Utilisez votre position actuelle à l’endroit où se trouve le domicile.")
                            .foregroundStyle(.secondary)
                    }
                    Button("Utiliser ma position actuelle") {
                        location.requestAlwaysPermission()
                        location.refreshCurrentLocation()
                    }
                }
                Section {
                    Text("Les membres invités verront cette zone afin que leur téléphone puisse détecter les arrivées et départs. Choisissez un rayon qui évite les déclenchements à la limite de la rue.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Créer un domicile")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Créer") {
                        guard let latitude, let longitude else { return }
                        isSaving = true
                        Task {
                            if await store.createHome(name: name, latitude: latitude, longitude: longitude, radiusMeters: Int(radius)) {
                                dismiss()
                            }
                            isSaving = false
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || latitude == nil || isSaving)
                }
            }
            .onAppear {
                if let currentLocation = location.currentLocation {
                    latitude = currentLocation.coordinate.latitude
                    longitude = currentLocation.coordinate.longitude
                }
            }
            .onChange(of: location.currentLocation) { _, currentLocation in
                latitude = currentLocation?.coordinate.latitude
                longitude = currentLocation?.coordinate.longitude
            }
        }
    }
}

private struct JoinHomeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: AppStore
    @State private var code = ""
    @State private var isJoining = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Code d’invitation", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Les invitations expirent après sept jours et ne peuvent être utilisées qu’une fois.")
                }
            }
            .navigationTitle("Rejoindre un domicile")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Rejoindre") {
                        isJoining = true
                        Task {
                            if await store.acceptInvitation(code: code.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() }
                            isJoining = false
                        }
                    }
                    .disabled(code.isEmpty || isJoining)
                }
            }
        }
    }
}

private struct InviteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: AppStore
    let home: PresenceHome
    @State private var role: HomeRole = .member
    @State private var invitation: InviteResult?
    @State private var isCreating = false

    var body: some View {
        NavigationStack {
            Form {
                if let invitation {
                    Section {
                        Text(invitation.code)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        ShareLink(item: PresenceL10n.format(
                            "invite.share",
                            fallback: "Rejoignez %@ dans Présence avec ce code : %@",
                            home.name,
                            invitation.code
                        )) {
                            Label("Partager l’invitation", systemImage: "square.and.arrow.up")
                        }
                    } header: {
                        Text("Invitation prête")
                    } footer: {
                        Text(PresenceL10n.format(
                            "invite.expiration",
                            fallback: "Ce code expire le %@. Il ne permet d’accéder qu’à ce domicile.",
                            invitation.expiresAt.formattedDate
                        ))
                    }
                } else {
                    Section {
                        Picker("Rôle", selection: $role) {
                            Text(HomeRole.member.label).tag(HomeRole.member)
                            Text(HomeRole.admin.label).tag(HomeRole.admin)
                        }
                    } header: {
                        Text("Accès")
                    } footer: {
                        Text("Un administrateur peut inviter d’autres membres et créer des codes d’invitation.")
                    }
                }
            }
            .navigationTitle("Inviter un membre")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fermer") { dismiss() } }
                if invitation == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Créer le code") {
                            isCreating = true
                            Task {
                                do { invitation = try await store.invite(home: home, role: role) }
                                catch { store.present(error) }
                                isCreating = false
                            }
                        }
                        .disabled(isCreating)
                    }
                }
            }
        }
    }
}

private extension String {
    var formattedDate: String {
        guard let date = ISO8601DateFormatter().date(from: self) else { return self }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
