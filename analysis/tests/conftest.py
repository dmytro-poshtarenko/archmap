import pandas as pd
import pytest

from archmap_analysis.data import COLUMNS


def unit(i, file, stratum, weight, in_cstar, case, predicted, correct, is_site=1):
    row = dict.fromkeys(COLUMNS, "")
    row.update(
        unit=f"r:{file}:{i}", file=f"r:{file}", repo="r", path=file, line=i, stratum=stratum, weight=weight,
        label_is_site=is_site, label_case=case, in_cstar=in_cstar, predicted=predicted, correct=correct,
    )
    return row


@pytest.fixture
def toy() -> pd.DataFrame:
    """
    The toy set of the TypeScript evaluator test, after alignment (the
    duplicate line dropped): C* = 5 with one case 8, correct 2, linked 5;
    http units weigh 10, db units 2.
    """
    rows = [
        unit(1, "a.ts", "http", 10, 1, 1, 1, 1),
        unit(2, "a.ts", "http", 10, 1, 2, 1, 0),
        unit(3, "a.ts", "http", 10, 1, 8, 0, 0),
        unit(4, "a.ts", "http", 10, 0, None, 1, 0),
        unit(105, "b.ts", "db", 2, 0, None, 1, 0, is_site=0),
        unit(106, "b.ts", "db", 2, 1, 5, 0, 0),
        unit(108, "b.ts", "db", 2, 1, 2, 1, 1),
    ]
    df = pd.DataFrame(rows, columns=COLUMNS)
    df["label_case"] = pd.to_numeric(df["label_case"], errors="coerce")
    return df
