%% Pairwise hand movement amount during shared trials
% 共有カーソルとお互いのカーソルをフィードバック
clear; clc;

dataDir = "C:\Users\owner\Dropbox\MATLAB\FY2026\JointAgency\AnalyzedData";

groups = [13 14 15 18 19];
sharedTrials = 4:17;
baseTrials = [1:3, 18:20];

nG = numel(groups);
nT = numel(sharedTrials);

% g13とg14, g18はp1/p2を交換して解析...-> 全グループ p1>>p2 になる
swapPair = ismember(groups, [13 14 18]);

%% シングルカーソルとターゲットとの誤差
d_p1_err = nan(nG, length(baseTrials));
d_p2_err = nan(nG, length(baseTrials));

for gi = 1:nG
    g = groups(gi);
    S = load(fullfile(dataDir, sprintf("g%d_trialwise.mat", g)));
    trialData = S.trialData;

    for ti = 1:length(baseTrials)
        tr = baseTrials(ti);
        D = trialData(tr);

        test1Err = hypot(D.test1_cursorX - D.test1_targetX, ...
                         D.test1_cursorY - D.test1_targetY);
        test2Err = hypot(D.test2_cursorX - D.test2_targetX, ...
                         D.test2_cursorY - D.test2_targetY);

        if swapPair(gi)
            dist1 = test2Err;
            dist2 = test1Err;
        else
            dist1 = test1Err;
            dist2 = test2Err;
        end

        dist1(dist1 > 0.2) = nan; % 外れ値処理
        dist2(dist2 > 0.2) = nan; % 外れ値処理

        d_p1_err(gi, ti) = mean(dist1, 'omitnan');
        d_p2_err(gi, ti) = mean(dist2, 'omitnan');
    end
end

%% 共有カーソルとターゲットとの誤差
d_sh_err = nan(nG,nT);

for gi = 1:nG
    g = groups(gi);
    S = load(fullfile(dataDir, sprintf("g%d_trialwise.mat", g)));
    trialData = S.trialData;

    for ti = 1:nT
        tr = sharedTrials(ti);
        D = trialData(tr);

        dist = hypot(D.sharedCursorX - D.targetX, ...
                     D.sharedCursorY - D.targetY);
        dist(dist > 0.2) = nan; % 外れ値処理
        d_sh_err(gi, ti) = mean(dist, 'omitnan');
    end
end


%% 参加者移動距離の偏り具合

moveP1 = nan(nG, nT);
moveP2 = nan(nG, nT);
p1Ratio = nan(nG, nT);

for gi = 1:nG
    g = groups(gi);
    S = load(fullfile(dataDir, sprintf("g%d_trialwise.mat", g)));
    trialData = S.trialData;

    for ti = 1:nT
        tr = sharedTrials(ti);
        D = trialData(tr);

        moveP1(gi,ti) = trajectoryLength(D.test1_HandX, D.test1_HandY);
        moveP2(gi,ti) = trajectoryLength(D.test2_HandX, D.test2_HandY);

        ratio = moveP1(gi,ti) / ...
            (moveP1(gi,ti) + moveP2(gi,ti));

        if swapPair(gi)
            ratio = 1 - ratio;
        end

        p1Ratio(gi,ti) = ratio;
    end
end

%% Plot raw movement amount
figure("Color","w");
tiledlayout(2,6)

nexttile(1,[1,1]); hold on
plot(1:3, d_p1_err(:,1:3)', 'r-')
plot(1:3, d_p2_err(:,1:3)', 'b-')
xlabel("Trial");
ylabel("Distance error");
title("Red:P1, Blue:P2");
xlim([1 3])
ylim([0 0.13])
grid on;

nexttile(6,[1,1]); hold on
plot(18:20, d_p1_err(:,4:6)', 'r-')
plot(18:20, d_p2_err(:,4:6)', 'b-')
xlabel("Trial");
% ylabel("Distance error");
% title("Averaged distance between the cursor and target");
xlim([18 20])
ylim([0 0.13])
grid on;

nexttile(2,[1,4]); hold on;
plot(sharedTrials, d_sh_err', "Color", [0.5 0.5 0.5], "LineWidth", 1.2)
plot(sharedTrials, mean(d_sh_err, 1, 'omitnan'), "k-", "LineWidth", 2.5)
xlabel("Trial");
% ylabel("Distance error");
title("Averaged distance between the shared cursor and target");
xlim([sharedTrials(1) sharedTrials(end)])
ylim([0 0.13])
grid on;

nexttile(8,[1,4]); hold on;
plot(sharedTrials, p1Ratio', "Color", [0.5 0.5 0.5], "LineWidth", 1.2);
plot(sharedTrials, mean(p1Ratio,1,"omitnan"), "k-", "LineWidth", 2.5);
yline(0.5, "k--", "Equal");
ylim([0 1]);
xlabel("Trial");
ylabel("Movement ratio, P1/(P1+P2)");
title("Within-pair movement bias");
xlim([sharedTrials(1) sharedTrials(end)])
grid on;

%% Local function
function L = trajectoryLength(x, y)
    x = x(:);
    y = y(:);

    ok = isfinite(x) & isfinite(y);
    x = x(ok);
    y = y(ok);

    if numel(x) < 2
        L = nan;
        return;
    end

    dx = diff(x);
    dy = diff(y);

    L = sum(hypot(dx, dy), "omitnan");
end
