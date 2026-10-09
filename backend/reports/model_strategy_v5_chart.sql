WITH model_comparison (
    horizon,
    months,
    candidate,
    relative_improvement_pct,
    model_mae_pct,
    baseline_mae_pct,
    rank_ic,
    validation_status
) AS (
    VALUES
        ('1 mese', 1, 'Annuale', -0.6103, 7.6001, 7.5540, 0.0080, 'Non validato'),
        ('1 mese', 1, 'Trimestrale', -0.3820, 7.5828, 7.5540, -0.0058, 'Non validato'),
        ('3 mesi', 3, 'Annuale', -0.0066, 13.9489, 13.9480, 0.0555, 'Non validato'),
        ('3 mesi', 3, 'Trimestrale', 0.0914, 13.9352, 13.9480, -0.0375, 'Holdout non confermato'),
        ('1 anno', 12, 'Annuale', -1.0122, 29.2201, 28.9273, 0.0540, 'Non validato'),
        ('1 anno', 12, 'Trimestrale', 0.5383, 28.7716, 28.9273, 0.0607, 'Validato nei gate correnti')
)
SELECT
    horizon,
    months,
    candidate,
    relative_improvement_pct,
    model_mae_pct,
    baseline_mae_pct,
    rank_ic,
    validation_status
FROM model_comparison
ORDER BY months, candidate;
