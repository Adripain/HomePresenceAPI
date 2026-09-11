import Foundation

/// Stores only pending arrival/departure states, never a GPS trace. This makes a
/// short loss of network survivable without retaining precise location locally.
@MainActor
final class PresenceOutbox {
    private let storageKey = "presence.pending.events"
    private var events: [PresenceReport]

    init() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([PresenceReport].self, from: data) else {
            events = []
            return
        }
        events = decoded
    }

    func append(_ report: PresenceReport) {
        events.append(report)
        // Prevent an unbounded queue if the phone remains offline for days.
        if events.count > 100 { events.removeFirst(events.count - 100) }
        persist()
    }

    func remove(id: String) {
        events.removeAll { $0.id == id }
        persist()
    }

    func discardExpired() {
        let cutoff = Date().addingTimeInterval(-15 * 60)
        events.removeAll { $0.observedAt < cutoff }
        persist()
    }

    var pending: [PresenceReport] { events }

    private func persist() {
        UserDefaults.standard.set(try? JSONEncoder().encode(events), forKey: storageKey)
    }
}
