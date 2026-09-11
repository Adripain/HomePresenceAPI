import Combine
import CoreLocation
import Foundation

@MainActor
final class LocationService: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var authorizationStatus: CLAuthorizationStatus = .notDetermined
    @Published private(set) var currentLocation: CLLocation?
    @Published private(set) var statusMessage: String?

    private let manager = CLLocationManager()
    private var homesByRegionIdentifier: [String: PresenceHome] = [:]
    private var latestState: [String: Bool] = [:]
    var onPresenceChange: ((PresenceReport) -> Void)?

    override init() {
        super.init()
        authorizationStatus = manager.authorizationStatus
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.pausesLocationUpdatesAutomatically = true
        manager.allowsBackgroundLocationUpdates = true
    }

    var hasAlwaysPermission: Bool { authorizationStatus == .authorizedAlways }
    private var canReadCurrentLocation: Bool {
        authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse
    }

    func requestAlwaysPermission() {
        switch authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
        default:
            break
        }
    }

    func refreshCurrentLocation() {
        guard canReadCurrentLocation else {
            requestAlwaysPermission()
            return
        }
        statusMessage = nil
        manager.requestLocation()
    }

    func configureMonitoring(homes: [PresenceHome]) {
        homesByRegionIdentifier = Dictionary(uniqueKeysWithValues: homes.prefix(20).map { (regionID(for: $0.id), $0) })
        let expected = Set(homesByRegionIdentifier.keys)
        for region in manager.monitoredRegions where !expected.contains(region.identifier) {
            manager.stopMonitoring(for: region)
        }
        guard hasAlwaysPermission else {
            statusMessage = PresenceL10n.text("location.always_required", fallback: "Autorisez la position « Toujours » pour mettre à jour la présence en arrière-plan.")
            return
        }
        for (identifier, home) in homesByRegionIdentifier {
            if manager.monitoredRegions.contains(where: { $0.identifier == identifier }) { continue }
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: home.latitude, longitude: home.longitude),
                radius: CLLocationDistance(home.radiusMeters),
                identifier: identifier
            )
            region.notifyOnEntry = true
            region.notifyOnExit = true
            manager.startMonitoring(for: region)
            manager.requestState(for: region)
        }
        manager.startMonitoringSignificantLocationChanges()
        // A newly created or joined home needs an initial state now; waiting
        // only for the next geographic boundary event leaves it as "away".
        refreshCurrentLocation()
        statusMessage = homes.count > 20 ? PresenceL10n.text("location.home_limit", fallback: "Les 20 premiers domiciles sont surveillés par iOS.") : nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        if authorizationStatus == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
            // The initial position is also useful while iOS presents the
            // follow-up request for background access.
            refreshCurrentLocation()
        } else if hasAlwaysPermission {
            configureMonitoring(homes: Array(homesByRegionIdentifier.values))
            refreshCurrentLocation()
        } else if authorizationStatus == .denied || authorizationStatus == .restricted {
            statusMessage = PresenceL10n.text("location.required", fallback: "La position est requise pour créer et surveiller un domicile.")
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        currentLocation = location
        for home in homesByRegionIdentifier.values {
            let inside = location.distance(from: CLLocation(latitude: home.latitude, longitude: home.longitude)) <= Double(home.radiusMeters)
            report(home: home, isPresent: inside, source: .heartbeat)
        }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard let home = homesByRegionIdentifier[region.identifier] else { return }
        report(home: home, isPresent: true, source: .regionEnter)
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard let home = homesByRegionIdentifier[region.identifier] else { return }
        report(home: home, isPresent: false, source: .regionExit)
    }

    func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard let home = homesByRegionIdentifier[region.identifier] else { return }
        switch state {
        case .inside: report(home: home, isPresent: true, source: .heartbeat)
        case .outside: report(home: home, isPresent: false, source: .heartbeat)
        case .unknown: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        statusMessage = PresenceL10n.text("location.unavailable", fallback: "La position n’est pas disponible actuellement.")
    }

    private func report(home: PresenceHome, isPresent: Bool, source: PresenceSource) {
        guard latestState[home.id] != isPresent else { return }
        latestState[home.id] = isPresent
        onPresenceChange?(PresenceReport(id: UUID().uuidString, homeID: home.id, isPresent: isPresent, source: source, observedAt: Date()))
    }

    private func regionID(for homeID: String) -> String { "presence.home.\(homeID)" }
}
