const SIDES = {
    left: { shoulder: 11, elbow: 13, wrist: 15 },
    right: { shoulder: 12, elbow: 14, wrist: 16 }
};

const MIN_VISIBILITY = 0.45;
const MIN_VALID_FRAMES = 10;
const MIN_VALID_FRAME_RATIO = 0.3;

export function checkBicepCurlViewQuality(frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
        return {
            valid: false,
            score: 0,
            side: null,
            message: "No pose was detected. Use a well-lit video with your upper body and full curling arm in frame."
        };
    }

    const sides = Object.fromEntries(
        Object.entries(SIDES).map(([name, indices]) => [
            name,
            { count: 0, visibilityTotal: 0, indices }
        ])
    );

    for (const frame of frames) {
        if (!Array.isArray(frame?.landmarks)) continue;

        for (const side of Object.values(sides)) {
            const points = [
                frame.landmarks[side.indices.shoulder],
                frame.landmarks[side.indices.elbow],
                frame.landmarks[side.indices.wrist]
            ];

            if (points.some(point =>
                !point ||
                !Number.isFinite(point.x) ||
                !Number.isFinite(point.y)
            )) continue;

            const visibility = Math.min(
                ...points.map(point => point.visibility ?? point.presence ?? 1)
            );

            if (!Number.isFinite(visibility) || visibility < MIN_VISIBILITY) continue;

            side.count++;
            side.visibilityTotal += visibility;
        }
    }

    const candidates = Object.entries(sides)
        .map(([name, side]) => ({
            side: name,
            count: side.count,
            score: side.count ? side.visibilityTotal / side.count : 0
        }));

    const isReliable = candidate =>
        candidate.count >= MIN_VALID_FRAMES &&
        candidate.count / frames.length >= MIN_VALID_FRAME_RATIO;
    const best =
        candidates.filter(isReliable).sort((a, b) => b.score - a.score)[0] ??
        candidates.sort((a, b) => b.count - a.count || b.score - a.score)[0];
    const valid = isReliable(best);

    return {
        valid,
        score: best.score,
        side: valid ? best.side : null,
        message: valid
            ? null
            : "Keep one shoulder, elbow, and wrist clearly visible throughout the video. Move the camera closer or improve the lighting, then try again."
    };
}
