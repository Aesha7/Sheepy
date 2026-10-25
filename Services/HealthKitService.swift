import Foundation
import HealthKit

@MainActor
final class HealthKitService: SleepProviding {
    let dataMode: PlanningDataMode = .live
    private lazy var store = HKHealthStore()
    private let timeZone: TimeZone

    init(timeZone: TimeZone = .current) { self.timeZone = timeZone }

    private func checkAvailability() throws {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw SheepFailure("HealthKit is unavailable on this device.")
        }
    }

    /// Completion means the authorization flow completed, NOT that reads were granted.
    func requestAccess() async throws {
        try checkAvailability()
        try await store.requestAuthorization(toShare: [], read: [
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!,
            HKObjectType.quantityType(forIdentifier: .heartRate)!
        ])
    }

    func sleepSummary(before referenceDate: Date) async throws -> SleepSummary? {
        try checkAvailability()
        guard referenceDate.timeIntervalSinceReferenceDate.isFinite else {
            throw SheepFailure("Sleep reference date must be finite.")
        }
        let lower = referenceDate.addingTimeInterval(-14 * 24 * 3600)
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        // Include overlapping samples so a session crossing the reference is rejected,
        // rather than presenting its earlier stages as a completed night.
        let samples = try await query(type: sleepType, start: lower, end: referenceDate)
        let asleep = Set([HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                          HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                          HKCategoryValueSleepAnalysis.asleepREM.rawValue,
                          HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue])
        let segments = samples.compactMap { sample -> SleepSessionProcessor.Segment? in
            guard let sleep = sample as? HKCategorySample, asleep.contains(sleep.value) else { return nil }
            return .init(source: sleep.sourceRevision.source.bundleIdentifier,
                         start: sleep.startDate, end: sleep.endDate)
        }
        guard let session = SleepSessionProcessor.select(segments, before: referenceDate,
                                                         since: lower, timeZone: timeZone) else { return nil }
        var heart: [SleepSessionProcessor.HeartReading] = []
        do {
            let heartSamples = try await query(type: HKObjectType.quantityType(forIdentifier: .heartRate)!,
                                               start: session.start, end: session.end)
            let bpm = HKUnit.count().unitDivided(by: .minute())
            heart = heartSamples.compactMap { sample in
                guard let reading = sample as? HKQuantitySample else { return nil }
                return .init(source: reading.sourceRevision.source.bundleIdentifier,
                             date: reading.startDate, bpm: reading.quantity.doubleValue(for: bpm))
            }
        } catch is CancellationError { throw CancellationError() }
        catch { /* Optional HR failure must not discard readable sleep. */ }
        try Task.checkCancellation()
        return SleepSessionProcessor.summary(session, heart: heart)
    }

    private func query(type: HKSampleType, start: Date, end: Date) async throws -> [HKSample] {
        try Task.checkCancellation()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let samples: [HKSample] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate,
                                      limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: samples ?? []) }
            }
            store.execute(query)
        }
        try Task.checkCancellation()
        return samples
    }
}
