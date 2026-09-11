import SwiftUI
import WidgetKit

struct PresenceWidgetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> PresenceWidgetEntry {
        PresenceWidgetEntry(
            date: .now,
            home: PresenceWidgetHome(id: "preview", name: "Maison", presentCount: 2, refreshedAt: .now)
        )
    }

    func snapshot(for configuration: SelectPresenceHomeIntent, in context: Context) async -> PresenceWidgetEntry {
        entry(for: configuration)
    }

    func timeline(for configuration: SelectPresenceHomeIntent, in context: Context) async -> Timeline<PresenceWidgetEntry> {
        Timeline(
            entries: [entry(for: configuration)],
            // The host app reloads this timeline as soon as it receives new
            // presence data. This fallback prevents a permanently stale widget.
            policy: .after(Date().addingTimeInterval(15 * 60))
        )
    }

    private func entry(for configuration: SelectPresenceHomeIntent) -> PresenceWidgetEntry {
        let home = PresenceSharedStore.homes().first { $0.id == configuration.home?.id }
        return PresenceWidgetEntry(date: .now, home: home)
    }
}

struct PresenceWidgetEntry: TimelineEntry {
    let date: Date
    let home: PresenceWidgetHome?
}

struct PresenceWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PresenceWidgetEntry

    var body: some View {
        Group {
            if let home = entry.home {
                VStack(alignment: .leading, spacing: 8) {
                    Label(home.name, systemImage: "house.fill")
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(PresenceL10n.presentCount(home.presentCount))
                        .font(.system(size: family == .systemSmall ? 21 : 27, weight: .bold, design: .rounded))
                        .contentTransition(.numericText())
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                    if family != .systemSmall {
                        Text(PresenceL10n.text(
                            home.presentCount == 0 ? "widget.empty" : "widget.detected",
                            fallback: home.presentCount == 0 ? "Personne n’est à la maison" : "Présence détectée"
                        ))
                            .font(.footnote)
                            .foregroundStyle(home.presentCount == 0 ? Color.secondary : Color.green)
                    }
                }
            } else {
                ContentUnavailableView(
                    "Choisissez un domicile",
                    systemImage: "house",
                    description: Text("Maintenez le widget appuyé, puis touchez Modifier le widget.")
                )
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct PresenceWidget: Widget {
    static let kind = "adriendtz.isanyonehome.presence"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: SelectPresenceHomeIntent.self, provider: PresenceWidgetProvider()) { entry in
            PresenceWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Présence du domicile")
        .description("Affiche le nombre de personnes présentes dans le domicile choisi.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

#Preview(as: .systemSmall) {
    PresenceWidget()
} timeline: {
    PresenceWidgetEntry(date: .now, home: PresenceWidgetHome(id: "preview", name: "Maison", presentCount: 2, refreshedAt: .now))
    PresenceWidgetEntry(date: .now, home: PresenceWidgetHome(id: "preview", name: "Maison", presentCount: 0, refreshedAt: .now))
}
